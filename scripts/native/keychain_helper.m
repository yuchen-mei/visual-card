/* Closed native credential boundary. Building/preflight never enrolls a secret.
 * Enroll/serve require explicit orchestration after review of the exact build.
 * Only embedded program bytes execute; neither verb accepts a script/command.
 */
#import <Foundation/Foundation.h>
#include <Security/Security.h>
#include <spawn.h>
#include <sys/spawn.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <pwd.h>
#include <poll.h>
#include <fcntl.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>
#include "sealed_resources.h"
#define VISUAL_CARD_PREFLIGHT_NO_MAIN
#include "keychain_preflight.c"

static const char *SERVICE = "visual-card.website-password";
static int failed(const char *code) { return reject(code); }
static void wipe(NSMutableData *data) { if (data.length) memset(data.mutableBytes, 0, data.length); }
static BOOL exactKeys(NSDictionary *d, NSArray *keys) {
    return [d isKindOfClass:NSDictionary.class] && d.count == keys.count && [[NSSet setWithArray:d.allKeys] isEqualToSet:[NSSet setWithArray:keys]];
}
static BOOL matches(id value, NSString *pattern) {
    if (![value isKindOfClass:NSString.class]) return NO;
    return [value rangeOfString:pattern options:NSRegularExpressionSearch].location != NSNotFound;
}
static NSMutableData *readBounded(int fd, NSUInteger limit) {
    NSMutableData *data = [NSMutableData data]; unsigned char buffer[4096];
    for (;;) {
        ssize_t n = read(fd, buffer, sizeof(buffer));
        if (n < 0 && errno == EINTR) continue;
        if (n < 0 || (NSUInteger)n > limit - data.length) { wipe(data); memset(buffer,0,sizeof(buffer)); return nil; }
        if (!n) break;
        [data appendBytes:buffer length:(NSUInteger)n];
    }
    memset(buffer,0,sizeof(buffer)); return data;
}
static BOOL writeAll(int fd, const void *bytes, size_t length) {
    const unsigned char *p = bytes;
    while (length) { ssize_t n=write(fd,p,length); if(n<0&&errno==EINTR)continue; if(n<=0)return NO; p+=n;length-=(size_t)n; }
    return YES;
}
static NSData *readLine(int fd, NSUInteger limit, NSDate *deadline) {
    NSMutableData *data=[NSMutableData data]; unsigned char c;
    while (data.length <= limit) {
        NSTimeInterval remaining=deadline.timeIntervalSinceNow;
        if(remaining<=0)return nil;
        struct pollfd item={fd,POLLIN,0}; int ready=poll(&item,1,(int)MIN(remaining*1000,300000));
        if(ready<0&&errno==EINTR)continue; if(ready<=0)return nil;
        ssize_t n=read(fd,&c,1); if(n<0&&errno==EINTR)continue; if(n!=1)return nil;
        if(c=='\n')return data;
        [data appendBytes:&c length:1];
    }
    return nil;
}
static BOOL emit(NSDictionary *value) {
    NSData *data=[NSJSONSerialization dataWithJSONObject:value options:0 error:NULL];
    return data && writeAll(STDOUT_FILENO,data.bytes,data.length) && writeAll(STDOUT_FILENO,"\n",1);
}
static NSDictionary *json(NSData *bytes) {
    if(!bytes)return nil; id value=[NSJSONSerialization JSONObjectWithData:bytes options:0 error:NULL];
    return [value isKindOfClass:NSDictionary.class]?value:nil;
}

static SecAccessRef makeAccess(void) {
    SecTrustedApplicationRef app=NULL;SecAccessRef access=NULL;
    if(SecTrustedApplicationCreateFromPath(NULL,&app)!=errSecSuccess)return NULL;
    const void *objects[]={app};CFArrayRef apps=CFArrayCreate(NULL,objects,1,&kCFTypeArrayCallBacks);
    if(apps)SecAccessCreate(CFSTR("visual-card website password"),apps,&access);
    if(apps)CFRelease(apps);CFRelease(app);return access;
}
static BOOL exactReadAccess(SecAccessRef access) {
    SecTrustedApplicationRef self=NULL;CFDataRef data=NULL;CFArrayRef acls=NULL;BOOL ok=NO;int count=0;
    if(SecTrustedApplicationCreateFromPath(NULL,&self)!=errSecSuccess||SecTrustedApplicationCopyData(self,&data)!=errSecSuccess||SecAccessCopyACLList(access,&acls)!=errSecSuccess)goto end;
    for(CFIndex i=0;i<CFArrayGetCount(acls);i++) {
        SecACLRef acl=(SecACLRef)CFArrayGetValueAtIndex(acls,i);CFArrayRef auth=SecACLCopyAuthorizations(acl);
        if(!auth)goto end;CFRange all=CFRangeMake(0,CFArrayGetCount(auth));
        BOOL broad=CFArrayContainsValue(auth,all,kSecACLAuthorizationAny),decrypt=CFArrayContainsValue(auth,all,kSecACLAuthorizationDecrypt);CFRelease(auth);
        if(broad)goto end;if(!decrypt)continue;
        CFArrayRef apps=NULL;CFStringRef description=NULL;SecKeychainPromptSelector prompt=0;CFDataRef other=NULL;
        BOOL valid=SecACLCopyContents(acl,&apps,&description,&prompt)==errSecSuccess&&apps&&CFArrayGetCount(apps)==1;
        if(valid)valid=SecTrustedApplicationCopyData((SecTrustedApplicationRef)CFArrayGetValueAtIndex(apps,0),&other)==errSecSuccess&&CFEqual(other,data);
        if(other)CFRelease(other);if(apps)CFRelease(apps);if(description)CFRelease(description);
        if(!valid)goto end;count++;
    }
    ok=count>0;
end:
    if(acls)CFRelease(acls);if(data)CFRelease(data);if(self)CFRelease(self);return ok;
}
static SecKeychainRef loginKeychain(void) {
    struct passwd *user=getpwuid(getuid());if(!user||!user->pw_dir)return NULL;
    NSString *path=[[NSString stringWithUTF8String:user->pw_dir] stringByAppendingPathComponent:@"Library/Keychains/login.keychain-db"];
    SecKeychainRef keychain=NULL;if(SecKeychainOpen(path.fileSystemRepresentation,&keychain)!=errSecSuccess)return NULL;return keychain;
}
static int enroll(void) {
    NSMutableData *secret=readBounded(3,4096);close(3);
    if(!secret.length)return failed("E_PASSWORD_INPUT");
    SecKeychainRef keychain=loginKeychain();SecAccessRef access=makeAccess();SecKeychainItemRef item=NULL;
    if(!keychain||!access||!exactReadAccess(access)){wipe(secret);if(keychain)CFRelease(keychain);if(access)CFRelease(access);return failed("E_ENROLLMENT_ACCESS");}
    SecKeychainAttribute attrs[]={{kSecServiceItemAttr,(UInt32)strlen(SERVICE),(void *)SERVICE},{kSecAccountItemAttr,(UInt32)strlen(VC_ACCOUNT),(void *)VC_ACCOUNT}};
    SecKeychainAttributeList list={2,attrs};
    OSStatus status=SecKeychainItemCreateFromContent(kSecGenericPasswordItemClass,&list,(UInt32)secret.length,secret.bytes,keychain,access,&item);
    wipe(secret);CFRelease(access);CFRelease(keychain);
    if(status!=errSecSuccess){if(item)CFRelease(item);return failed(status==errSecDuplicateItem?"E_ITEM_ALREADY_EXISTS":"E_ENROLLMENT_FAILED");}
    SecAccessRef actual=NULL;
    BOOL verified=SecKeychainItemCopyAccess(item,&actual)==errSecSuccess&&exactReadAccess(actual);
    if(actual)CFRelease(actual);
    if(!verified){OSStatus removed=SecKeychainItemDelete(item);CFRelease(item);return failed(removed==errSecSuccess?"E_ENROLLMENT_ROLLED_BACK":"E_ENROLLMENT_RECOVERY_REQUIRED");}
    CFRelease(item);return emit(@{@"status":@"enrolled",@"passwordExported":@NO})?0:failed("E_STATUS_OUTPUT");
}
static NSMutableData *password(void) {
#ifdef VC_NATIVE_TEST
    return [[@"native-synthetic-password-only" dataUsingEncoding:NSUTF8StringEncoding] mutableCopy];
#else
    SecKeychainRef keychain=loginKeychain();if(!keychain)return nil;
    void *bytes=NULL;UInt32 length=0;SecKeychainItemRef item=NULL;
    OSStatus status=SecKeychainFindGenericPassword(keychain,(UInt32)strlen(SERVICE),SERVICE,(UInt32)strlen(VC_ACCOUNT),VC_ACCOUNT,&length,&bytes,&item);
    CFRelease(keychain);NSMutableData *result=nil;
    if(status==errSecSuccess&&length>0&&length<=4096&&item){
        SecAccessRef access=NULL;
        if(SecKeychainItemCopyAccess(item,&access)==errSecSuccess&&exactReadAccess(access))result=[NSMutableData dataWithBytes:bytes length:length];
        if(access)CFRelease(access);
    }
    if(bytes){memset(bytes,0,length);SecKeychainItemFreeContent(NULL,bytes);}if(item)CFRelease(item);return result;
#endif
}

static SecRequirementRef runtimeRequirement(void) {
    CFStringRef text=CFStringCreateWithCString(NULL,VC_NODE_REQUIREMENT,kCFStringEncodingUTF8);SecRequirementRef r=NULL;
    if(text){SecRequirementCreateWithString(text,kSecCSDefaultFlags,&r);CFRelease(text);}return r;
}
static BOOL verifyRuntime(SecRequirementRef requirement) {
    CFURLRef url=CFURLCreateFromFileSystemRepresentation(NULL,(const UInt8 *)VC_NODE,strlen(VC_NODE),false);SecStaticCodeRef code=NULL;BOOL ok=NO;
    if(url&&SecStaticCodeCreateWithPath(url,kSecCSDefaultFlags,&code)==errSecSuccess)ok=SecStaticCodeCheckValidity(code,kSecCSStrictValidate|kSecCSCheckAllArchitectures,requirement)==errSecSuccess;
    if(code)CFRelease(code);if(url)CFRelease(url);return ok;
}
static BOOL verifyChild(pid_t pid, SecRequirementRef requirement) {
    CFNumberRef number=CFNumberCreate(NULL,kCFNumberIntType,&pid);const void *keys[]={kSecGuestAttributePid},*values[]={number};
    CFDictionaryRef attributes=CFDictionaryCreate(NULL,keys,values,1,&kCFTypeDictionaryKeyCallBacks,&kCFTypeDictionaryValueCallBacks);SecCodeRef code=NULL;
    BOOL ok=SecCodeCopyGuestWithAttributes(NULL,attributes,kSecCSDefaultFlags,&code)==errSecSuccess&&SecCodeCheckValidity(code,kSecCSStrictValidate,requirement)==errSecSuccess;
    if(code)CFRelease(code);CFRelease(attributes);CFRelease(number);return ok;
}
static BOOL pipeHigh(int fds[2]) {
    int raw[2];if(pipe(raw))return NO;
    fds[0]=fcntl(raw[0],F_DUPFD_CLOEXEC,10);fds[1]=fcntl(raw[1],F_DUPFD_CLOEXEC,10);close(raw[0]);close(raw[1]);
    return fds[0]>=0&&fds[1]>=0;
}
static void closeFd(int *fd){if(*fd>=0){close(*fd);*fd=-1;}}
static BOOL validHeader(NSDictionary *d, NSDictionary *config) {
    if(!exactKeys(d,@[@"protocol",@"sessionId",@"expectedHead",@"baselineSha256",@"expiresAt",@"publicKey",@"seeds"])||![d[@"protocol"] isEqual:@"visual-card-rsa-oaep-sha256-v1"]||![d[@"expectedHead"] isEqual:config[@"expectedHead"]]||!matches(d[@"sessionId"],@"^[a-f0-9-]{36}$")||!matches(d[@"baselineSha256"],@"^[a-f0-9]{64}$")||!matches(d[@"expiresAt"],@"^[0-9T:Z.\\-]{20,30}$"))return NO;
    NSDictionary *key=d[@"publicKey"];if(!exactKeys(key,@[@"kty",@"n",@"e"])||![key[@"kty"] isEqual:@"RSA"]||!matches(key[@"n"],@"^[A-Za-z0-9_-]{512}$")||![key[@"e"] isEqual:@"AQAB"])return NO;
    NSArray *seeds=d[@"seeds"];if(![seeds isKindOfClass:NSArray.class]||seeds.count!=128)return NO;
    for(id seed in seeds)if(!matches(seed,@"^[a-f0-9]{64}$"))return NO;return YES;
}
static BOOL validResult(NSDictionary *d, NSDictionary *header, NSDictionary *config) {
    BOOL changed=[d[@"status"] isEqual:@"validated"],unchanged=[d[@"status"] isEqual:@"unchanged"];
    NSArray *keys=changed?@[@"operationId",@"expectedHead",@"baselineSha256",@"publication",@"status",@"candidatePath",@"validatedSha256"]:@[@"operationId",@"expectedHead",@"baselineSha256",@"publication",@"status"];
    if((!changed&&!unchanged)||!exactKeys(d,keys)||![d[@"publication"] isEqual:@"disabled"]||![d[@"expectedHead"] isEqual:header[@"expectedHead"]]||![d[@"baselineSha256"] isEqual:header[@"baselineSha256"]]||!matches(d[@"operationId"],@"^[A-Za-z0-9:._-]{1,120}$"))return NO;
    if(changed){NSString *file=d[@"candidatePath"],*dir=config[@"outputDirectory"];
        if(![file isKindOfClass:NSString.class]||![[file stringByDeletingLastPathComponent] isEqual:dir]||!matches(file.lastPathComponent,@"^candidate-[a-f0-9]{24}\\.enc\\.json$")||!matches(d[@"validatedSha256"],@"^[a-f0-9]{64}$"))return NO;
    }return YES;
}
static int serve(void) {
    NSMutableData *raw=readBounded(4,8192);close(4);NSDictionary *config=json(raw);
    if(!exactKeys(config,@[@"expectedHead",@"baselinePath",@"outputDirectory"])||!matches(config[@"expectedHead"],@"^[a-f0-9]{40}$")||![config[@"baselinePath"] isKindOfClass:NSString.class]||![config[@"outputDirectory"] isKindOfClass:NSString.class])return failed("E_CONFIG");
    NSString *baseline=config[@"baselinePath"],*output=config[@"outputDirectory"];char real[PATH_MAX];struct stat st;
    if(!baseline.isAbsolutePath||!output.isAbsolutePath||!realpath(output.fileSystemRepresentation,real)||strcmp(real,output.fileSystemRepresentation)||stat(real,&st)||!S_ISDIR(st.st_mode)||st.st_uid!=getuid()||(st.st_mode&077))return failed("E_PRIVATE_OUTPUT");
    if(stat(baseline.fileSystemRepresentation,&st)||!S_ISREG(st.st_mode)||st.st_size>24*1024*1024)return failed("E_BASELINE");
    SecRequirementRef requirement=runtimeRequirement();if(!requirement||!verifyRuntime(requirement)){if(requirement)CFRelease(requirement);return failed("E_RUNTIME_IDENTITY");}
    NSMutableData *secret=password();if(!secret){CFRelease(requirement);return failed("E_KEYCHAIN_UNAVAILABLE");}
    int pipes[5][2]={{-1,-1},{-1,-1},{-1,-1},{-1,-1},{-1,-1}};int nullfd=-1;pid_t child=-1;BOOL ok=NO;const char *error="E_CHILD_START";
    posix_spawn_file_actions_t actions;posix_spawnattr_t attr;BOOL actionsReady=NO,attrReady=NO;
    NSDictionary *header=nil,*result=nil;NSData *packet=nil;NSDate *deadline=[NSDate dateWithTimeIntervalSinceNow:300];
    for(int i=0;i<5;i++)if(!pipeHigh(pipes[i]))goto cleanup;
    nullfd=open("/dev/null",O_WRONLY|O_CLOEXEC);if(nullfd<0)goto cleanup;
    if(posix_spawn_file_actions_init(&actions))goto cleanup;actionsReady=YES;
    if(posix_spawnattr_init(&attr))goto cleanup;attrReady=YES;
    if(posix_spawnattr_setflags(&attr,POSIX_SPAWN_START_SUSPENDED|POSIX_SPAWN_CLOEXEC_DEFAULT))goto cleanup;
    if(posix_spawn_file_actions_adddup2(&actions,pipes[0][0],0)||posix_spawn_file_actions_adddup2(&actions,pipes[1][1],1)||posix_spawn_file_actions_adddup2(&actions,nullfd,2)||posix_spawn_file_actions_adddup2(&actions,pipes[2][0],3)||posix_spawn_file_actions_adddup2(&actions,pipes[3][0],4)||posix_spawn_file_actions_adddup2(&actions,pipes[4][0],5))goto cleanup;
    char *argv[]={(char *)VC_NODE,"--no-addons","--no-global-search-paths","-e","require('node:vm').runInThisContext(require('node:fs').readFileSync(5,'utf8'),{filename:'sealed-bootstrap.cjs'})",NULL};
    char *env[]={"PATH=/usr/bin:/bin","TZ=UTC","VISUAL_CARD_PASSWORD_FD=3",NULL};
    if(posix_spawn(&child,VC_NODE,&actions,&attr,argv,env))goto cleanup;
    error="E_CHILD_IDENTITY";if(!verifyChild(child,requirement))goto cleanup;
    closeFd(&pipes[0][0]);closeFd(&pipes[1][1]);closeFd(&pipes[2][0]);closeFd(&pipes[3][0]);closeFd(&pipes[4][0]);
    error="E_PRIVATE_PIPE";
    if(!writeAll(pipes[2][1],secret.bytes,secret.length))goto cleanup;wipe(secret);closeFd(&pipes[2][1]);
    if(kill(child,SIGCONT))goto cleanup;
    if(!writeAll(pipes[3][1],raw.bytes,raw.length))goto cleanup;closeFd(&pipes[3][1]);
    if(!writeAll(pipes[4][1],VC_BOOTSTRAP,sizeof(VC_BOOTSTRAP)-1))goto cleanup;closeFd(&pipes[4][1]);
    error="E_CHILD_PROTOCOL";header=json(readLine(pipes[1][0],16000,deadline));if(!validHeader(header,config)||!emit(header))goto cleanup;
    packet=readLine(STDIN_FILENO,110000,deadline);if(!packet)goto cleanup;
    if(!writeAll(pipes[0][1],packet.bytes,packet.length)||!writeAll(pipes[0][1],"\n",1))goto cleanup;closeFd(&pipes[0][1]);
    result=json(readLine(pipes[1][0],8192,deadline));if(!validResult(result,header,config))goto cleanup;
    {int status=0;if(waitpid(child,&status,0)!=child||!WIFEXITED(status)||WEXITSTATUS(status)!=0)goto cleanup;child=-1;}
    ok=emit(result);
cleanup:
    wipe(secret);if(child>0){kill(child,SIGKILL);while(waitpid(child,NULL,0)<0&&errno==EINTR){}}
    for(int i=0;i<5;i++){closeFd(&pipes[i][0]);closeFd(&pipes[i][1]);}closeFd(&nullfd);
    if(actionsReady)posix_spawn_file_actions_destroy(&actions);if(attrReady)posix_spawnattr_destroy(&attr);CFRelease(requirement);
    return ok?0:failed(error);
}
int main(int argc,char **argv) {
    @autoreleasepool {
        struct rlimit core={0,0};if(setrlimit(RLIMIT_CORE,&core))return failed("E_CORE_DUMP_POLICY");signal(SIGPIPE,SIG_IGN);
        if(argc!=2)return failed("E_CLOSED_VERB_REQUIRED");
        BOOL check=strcmp(argv[1],"--preflight")==0,install=strcmp(argv[1],"--enroll")==0,run=strcmp(argv[1],"--serve")==0;
        if(!check&&!install&&!run)return failed("E_CLOSED_VERB_REQUIRED");
#ifdef VC_NATIVE_TEST
        if(install)return failed("E_TEST_ENROLLMENT_DISABLED");
#endif
        if(preflight(check))return 1;if(check)return 0;
        if(SecKeychainSetUserInteractionAllowed(false)!=errSecSuccess)return failed("E_INTERACTION_POLICY");
        return install?enroll():serve();
    }
}
