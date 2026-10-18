/*
 * Non-secret design probe ONLY. This binary has no Keychain item APIs, no
 * password input, no child process, and no enrollment/read/export mode.
 * SecAccess/SecACL objects below exist only in process memory.
 */
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <stdio.h>
#include <string.h>

static int reject(const char *code) {
    fprintf(stderr, "%s\n", code);
    return 1;
}

static int preflight(int emit_status) {
    SecCodeRef running = NULL;
    SecStaticCodeRef binary = NULL;
    CFDictionaryRef info = NULL;
    SecRequirementRef designated = NULL, exact = NULL;
    CFStringRef designatedText = NULL, exactText = NULL;
    SecTrustedApplicationRef self = NULL;
    CFArrayRef trusted = NULL, acls = NULL;
    SecAccessRef access = NULL;
    CFDataRef selfData = NULL;
    const char *error = "E_NATIVE_PREFLIGHT";
    int result = 1;
    unsigned int flags = 0;
    long decryptAcls = 0;

    if (SecCodeCopySelf(kSecCSDefaultFlags, &running) != errSecSuccess ||
        SecCodeCopyStaticCode(running, kSecCSDefaultFlags, &binary) != errSecSuccess ||
        SecStaticCodeCheckValidity(binary, kSecCSStrictValidate | kSecCSCheckAllArchitectures, NULL) != errSecSuccess ||
        SecCodeCopySigningInformation(binary, kSecCSSigningInformation, &info) != errSecSuccess)
        goto cleanup;

    CFNumberRef codeFlags = CFDictionaryGetValue(info, kSecCodeInfoFlags);
    if (!codeFlags || CFGetTypeID(codeFlags) != CFNumberGetTypeID() ||
        !CFNumberGetValue(codeFlags, kCFNumberIntType, &flags)) goto cleanup;
    error = "E_HARDENED_ADHOC_REQUIRED";
    if (!(flags & kSecCodeSignatureAdhoc) || !(flags & kSecCodeSignatureRuntime)) goto cleanup;
    error = "E_ENTITLEMENTS_REJECTED";
    CFTypeRef entitlements = CFDictionaryGetValue(info, kSecCodeInfoEntitlementsDict);
    if (entitlements && (CFGetTypeID(entitlements) != CFDictionaryGetTypeID() ||
                        CFDictionaryGetCount((CFDictionaryRef)entitlements) != 0)) goto cleanup;

    /* The ad-hoc designated requirement must be exactly this CodeDirectory. */
    error = "E_EXACT_IDENTITY_REQUIRED";
    CFDataRef cdhash = CFDictionaryGetValue(info, kSecCodeInfoUnique);
    if (!cdhash || CFGetTypeID(cdhash) != CFDataGetTypeID() || CFDataGetLength(cdhash) != 20) goto cleanup;
    char expression[64] = "cdhash H\"";
    const unsigned char *bytes = CFDataGetBytePtr(cdhash);
    for (int i = 0; i < 20; i++) snprintf(expression + 9 + i * 2, 3, "%02x", bytes[i]);
    expression[49] = '"'; expression[50] = '\0';
    exactText = CFStringCreateWithCString(NULL, expression, kCFStringEncodingUTF8);
    if (!exactText || SecRequirementCreateWithString(exactText, kSecCSDefaultFlags, &exact) != errSecSuccess ||
        SecStaticCodeCheckValidity(binary, kSecCSStrictValidate, exact) != errSecSuccess ||
        SecCodeCopyDesignatedRequirement(binary, kSecCSDefaultFlags, &designated) != errSecSuccess ||
        SecRequirementCopyString(designated, kSecCSDefaultFlags, &designatedText) != errSecSuccess ||
        !CFEqual(designatedText, exactText)) goto cleanup;

    /* Explicit self-only list; never NULL or an interpreter path. */
    error = "E_TRUSTED_APPLICATION";
    if (SecTrustedApplicationCreateFromPath(NULL, &self) != errSecSuccess ||
        SecTrustedApplicationCopyData(self, &selfData) != errSecSuccess) goto cleanup;
    const void *onlySelf[] = {self};
    trusted = CFArrayCreate(NULL, onlySelf, 1, &kCFTypeArrayCallBacks);
    error = "E_ACCESS_OBJECT";
    if (!trusted || SecAccessCreate(CFSTR("visual-card native preflight (memory only)"), trusted, &access) != errSecSuccess ||
        SecAccessCopyACLList(access, &acls) != errSecSuccess) goto cleanup;

    /* Reject broad authorization and verify every decrypt ACL's trusted list. */
    error = "E_ACL_SCOPE";
    for (CFIndex i = 0; i < CFArrayGetCount(acls); i++) {
        SecACLRef acl = (SecACLRef)CFArrayGetValueAtIndex(acls, i);
        CFArrayRef auth = SecACLCopyAuthorizations(acl);
        if (!auth) goto cleanup;
        CFRange all = CFRangeMake(0, CFArrayGetCount(auth));
        int broad = CFArrayContainsValue(auth, all, kSecACLAuthorizationAny);
        int decrypt = CFArrayContainsValue(auth, all, kSecACLAuthorizationDecrypt);
        CFRelease(auth);
        if (broad) goto cleanup;
        if (!decrypt) continue;
        CFArrayRef apps = NULL;
        CFStringRef description = NULL;
        SecKeychainPromptSelector prompt = 0;
        OSStatus status = SecACLCopyContents(acl, &apps, &description, &prompt);
        int valid = status == errSecSuccess && apps && CFArrayGetCount(apps) == 1;
        CFDataRef appData = NULL;
        if (valid) valid = SecTrustedApplicationCopyData((SecTrustedApplicationRef)CFArrayGetValueAtIndex(apps, 0), &appData) == errSecSuccess && CFEqual(selfData, appData);
        if (appData) CFRelease(appData);
        if (apps) CFRelease(apps);
        if (description) CFRelease(description);
        if (!valid) goto cleanup;
        decryptAcls++;
    }
    if (decryptAcls < 1) goto cleanup;
    if (emit_status) puts("{\"status\":\"preflight_passed\",\"exactAdhocIdentity\":true,\"hardenedRuntime\":true,\"selfOnlyDecryptAclInMemory\":true,\"keychainItemsAccessed\":false,\"credentialStorageEnabled\":false}");
    result = 0;
cleanup:
    if (selfData) CFRelease(selfData);
    if (acls) CFRelease(acls);
    if (access) CFRelease(access);
    if (trusted) CFRelease(trusted);
    if (self) CFRelease(self);
    if (exactText) CFRelease(exactText);
    if (designatedText) CFRelease(designatedText);
    if (exact) CFRelease(exact);
    if (designated) CFRelease(designated);
    if (info) CFRelease(info);
    if (binary) CFRelease(binary);
    if (running) CFRelease(running);
    return result ? reject(error) : 0;
}

#ifndef VISUAL_CARD_PREFLIGHT_NO_MAIN
int main(int argc, char **argv) {
    if (argc != 2 || strcmp(argv[1], "--preflight") != 0) return reject("E_PREFLIGHT_ONLY");
    return preflight(1);
}
#endif
