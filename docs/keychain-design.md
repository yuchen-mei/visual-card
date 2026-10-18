# visual-card 专用钥匙串程序：审查结论

用户已允许把现有网页密码保存在这台 Mac 的登录钥匙串，供 visual-card 更新程序持续使用。此授权不扩大为让 Node、Python、`security` 命令或任意应用直接取得密码。专用 helper 已完成最终来源构建、独立源码审查、合成端到端测试和生产只读预检。**这些构建与测试没有创建、读取或修改任何密码条目；实际登记和真实运行结果须由部署流程另行确认。**

## 本机验证结果

- `xcrun` 能找到 Clang、Swift 编译器和 macOS SDK；`codesign` 可用。代码签名身份只读检查返回 0 个有效身份。
- 专用 C 程序可使用 ad-hoc 签名与 Hardened Runtime，无需创建签名证书。预检确认其 designated requirement 恰好是当前构建的 `cdhash`，没有 entitlement，并检查全部 ACL 中的解密授权只含该程序自身。
- `python3 scripts/native/test_keychain_preflight.py` 的 10 组检查通过：构建、拒绝未加固程序、签名校验、精确代码身份、内存 ACL、拒绝取密/任意参数模式、环境变量不影响预检及导入 API 检查。二进制在临时目录构建后删除；测试没有创建测试钥匙串或条目。
- 使用编译时模拟密码、禁用登记入口的测试构建，8 组端到端检查通过：固定 app Node 暂停启动及实际子进程身份核验、环境注入与伪造工作目录不影响嵌入代码、仅输出加密候选、历史保持、重复运行无变化且不生成候选、拒绝额外参数和取密模式。测试没有接触钥匙串条目，也没有使用真实密码。
- 受限执行环境中的签名验证报错不能直接判断二进制被篡改：对系统工具也出现信任评估失败。升级为只读签名验证后，`/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node` 通过严格签名检查，确认 `valid on disk` 并满足 designated requirement。它具有 Hardened Runtime，只链接系统库，已绑定精确身份并验证实际子进程。正常运行环境下检查到 JIT 与 unsigned-executable-memory 权限，未发现 get-task-allow、disable-library-validation 或 allow-dyld-environment-variables；专用原生 helper 自身没有 entitlement。现有 Homebrew Node 未加固且链接多项 Homebrew 动态库，本方案不采用。

独立预检源文件 `scripts/native/keychain_preflight.c` 只接受 `--preflight`，不能注册、读取或导出密码，也不启动子进程。其 `SecAccessCreate`、`SecACLCopyContents` 等只处理内存对象；独立预检二进制不链接 Keychain item 读写 API。完整 helper 为 `keychain_helper.m`，其登记及服务功能尚未用真实钥匙串运行。测试成功不代表已验证真实条目的访问拒绝行为或完成无人值守凭据配置。

## 已实现的固定接口

构建器 `scripts/native/build_keychain_helper.py` 只构建及签名，不登记密码。它要求仓库外的现有私有目录（当前用户所有、`0700`），拒绝覆盖已有输出；将 `finances_daily.cjs`、`update_finances.cjs` 和 `index.html` 的字节编入 helper，生成记录来源哈希、helper cdhash 及固定 Node cdhash 的 `build-manifest.json`。每次构建须使用已稳定并审查过的来源：

```sh
python3 scripts/native/build_keychain_helper.py --output-directory /private/approved-directory --account approved-local-identifier
```

构建时验证 app Node 的 Apple 签名链、OpenAI Team ID、`node` 标识符、严格代码完整性和 Hardened Runtime；不是仅从路径推断信任。`--test-only --account synthetic-test-only` 产生另一代码身份的测试构建，密码为编译时合成值，登记入口禁用，不能用于真实持久凭据。

真实 helper 仅接受以下单个固定动词，额外参数一律拒绝：

- `--preflight`：只检查自身代码身份和内存 ACL，不查询或更改条目。预检/构建输出的“未启用存储”只描述这次动作，不是对实际钥匙串状态的查询。
- `--enroll`：从调用者已安全准备的只读匿名管道 FD 3 接收既有密码，最多 4096 字节；service、account 及登录钥匙串位置都固定。仅创建新条目，遇到重复项停止，不覆盖；创建后核验实际 ACL，异常时删除刚创建的条目或报告需恢复。不接受密码参数、普通环境变量或输出密码的选项。
- `--serve`：从 FD 4 接收至多 8192 字节的纯数据 JSON，恰有 `expectedHead`、`baselinePath`、`outputDirectory`。目标目录须为规范化真实绝对路径，属于当前用户、权限 `0700`；基线是至多 24 MiB 的密文文件。密码由 helper 从固定条目读取，调用者不能指定 service、账号或代码路径。stdin 仅接收一次加密传输包，限时 5 分钟；stdout 仅允许经过严格结构检查的传输头与加密候选回执。传输头是临时私有运行数据，不能显示或持久保存。

服务将固定 Node 暂停启动，检查实际 PID 对应的代码身份后才释放密码，并使用固定 FD 3/4/5 分别传送密码、配置、嵌入 bootstrap。Node 只收到明确的 `PATH`、`TZ` 和密码 FD 编号环境；不继承 `NODE_OPTIONS`、`NODE_PATH`、`DYLD_*`。嵌入模块只允许已列出的 Node 内置模块和嵌入的 updater，不从仓库或工作目录加载 JS/HTML。密码及明文错误不会返回调用者；Git 发布不在此进程内。

## Apple API 的确切边界

`SecTrustedApplicationCreateFromPath(NULL, &app)` 为当前原生程序建立受信任应用引用。`SecAccessCreate` 的显式单元素应用列表可以限制哪些应用无需确认便访问条目。Apple 将代码身份与访问策略分开；本机缺少开发者证书并不阻止按精确代码哈希绑定一个 ad-hoc 构建。[Apple 代码签名与钥匙串策略](https://developer.apple.com/library/archive/technotes/tn2206/_index.html)、[代码需求中的 cdhash 与 ad-hoc 身份](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/RequirementLang/RequirementLang.html)

**“仅此程序可自动读取”不等于“钥匙串主人永远不能授权其他程序”。** Apple 的简单 ACL 为受信任程序列表保留用户确认路径。创建后只能声称专用程序是唯一免提示读取者，不能声称系统彻底消除了其他用户确认路径。`SecAccessCreate(..., NULL, ...)` 默认为创建者；`SecACLSetContents(..., NULL, ...)` 却可表示允许任何应用，不能混用。实现应始终用显式数组，并检查全部 ACL 和权限。[Apple ACL 实现](https://github.com/apple-oss-distributions/Security/blob/main/OSX/libsecurity_keychain/lib/ACL.cpp)、[SecACL API 实现](https://github.com/apple-oss-distributions/Security/blob/main/OSX/libsecurity_keychain/lib/SecACL.cpp)

这些 legacy macOS Keychain API 已弃用，但仍在本机 SDK 声明。实现时需直接核对以下头文件：`Security.framework/Headers/SecTrustedApplication.h`、`SecAccess.h`、`SecACL.h`、`SecKeychainItem.h`、`SecKeychain.h`。拟用的关键签名为：

```c
OSStatus SecTrustedApplicationCreateFromPath(const char *, SecTrustedApplicationRef *);
OSStatus SecAccessCreate(CFStringRef, CFArrayRef, SecAccessRef *);
OSStatus SecAccessCopyACLList(SecAccessRef, CFArrayRef *);
CFArrayRef SecACLCopyAuthorizations(SecACLRef);
OSStatus SecACLCopyContents(SecACLRef, CFArrayRef *, CFStringRef *, SecKeychainPromptSelector *);
OSStatus SecACLSetContents(SecACLRef, CFArrayRef, CFStringRef, SecKeychainPromptSelector);
OSStatus SecACLUpdateAuthorizations(SecACLRef, CFArrayRef);
OSStatus SecKeychainItemCreateFromContent(SecItemClass, SecKeychainAttributeList *,
    UInt32, const void *, SecKeychainRef, SecAccessRef, SecKeychainItemRef *);
OSStatus SecKeychainSetUserInteractionAllowed(Boolean);
```

登记实现把明确 ACL 作为 `initialAccess` 与条目一次创建，不先用宽泛默认权限保存密码再收窄。目标为登录钥匙串 generic password，service `visual-card.website-password`，account 为批准的本地账户标识。不得使用 `security -A`，不得添加通用解释器或 `security` 的受信任应用条目，也不得增加宽泛 partition list。无人值守程序禁用自身交互；锁定或需要用户确认时停止，不自动解锁钥匙串。

## 必须封闭整个执行链

以下要求约束已实现源码及最终审查；合成测试不能替代真实条目验证：

1. **固定行为。** 专用原生程序只执行固定更新入口，不提供 `read-password`、明文解密、任意可执行文件、任意脚本路径、任意输出文件描述符或参数转发。父进程是谁不能作为信任依据；任何同用户程序都可能启动它。
2. **固定代码。** `finances_daily.cjs`、其导入的 `update_finances.cjs`、浏览器校验所执行的 `index.html` JavaScript，以及所有后续可执行依赖都必须属于同一受审查构建。一个签名 Mach-O 不会自动保护旁边的 JS/HTML；完整签名 bundle 可以封装资源，但仍须在执行时验证。[Apple 关于嵌套代码与封装资源](https://developer.apple.com/library/archive/technotes/tn2206/_index.html)
3. **消除检查与使用之间的替换。** 在可写仓库路径先验哈希再让 Node 重新打开文件不够。当前实现把固定代码字节编入原生程序，通过匿名管道交给固定加载器，不在校验后重新按仓库路径加载代码。最终审查仍须覆盖新增动态 `require`、`vm` 和资源读取。
4. **验证运行时。** 固定使用通过验证的 app 内置 Node，校验签名、精确代码身份及依赖，并在释放密码前核实实际子进程身份。不能仅检查一个路径或 PATH 解析结果；应用更新导致代码身份变化时须停止并重新审查。可使用暂停启动和 `SecCodeCopyGuestWithAttributes` 按实际子进程身份核验，防止路径检查后的替换。此运行时需要 JIT/可执行内存权限，因此更不能将任意脚本、调试参数或加载器暴露给调用者。
5. **清理进程输入。** 子进程使用明确的最小环境，不能继承 `NODE_OPTIONS`、`NODE_PATH`、`DYLD_*`、预加载器、调试参数或调用者指定的工作目录；不得由 shell 解释命令。只传固定程序、固定参数以及经过结构校验的纯数据。Hardened Runtime 不应配置调试、任意动态库、关闭库验证等放宽权限。对 Node 确有需求的 JIT 权限须单独审查，不能照搬到取密程序。
6. **秘密只流向受检代码。** 密码不出现在 argv、普通环境变量、stdout/stderr、用户指定 FD、日志或文件中。匿名管道只交给固定受检子进程；关闭其他继承 FD，禁用 core dump，及时清理缓冲区。子进程输出须限制为固定状态或通过结构验证的加密候选，不能透传异常堆栈或任意文本。不要把 Git 和网络发布放进持有密码的进程。
7. **变更需重新核验。** 精确 ad-hoc `cdhash` 随构建变化；新代码不能自动继承旧条目的无提示权限。修改核心/HTML/加载器后需重新完成构建、测试与身份审查，再迁移专用程序访问授权。当前 helper 不提供自动扩大 ACL 或覆盖旧条目的迁移命令。

这些措施用于防止普通应用借专用 helper 取密，不承诺防御已经控制用户账户、取得管理员权限或由钥匙串主人明确批准的新访问。

## 部署与真实验证

最终来源的测试构建已通过 8 组端到端检查，独立预检已通过 10 组检查；生产构建的预检也确认精确 ad-hoc 身份、Hardened Runtime、显式自身解密 ACL。构建产物和来源哈希保存在仓库外私有部署目录的 manifest，不能把测试构建用于真实登记。

部署流程须核对该 manifest 后，按当前已获准的范围登记真实条目，并受控验证专用程序执行更新、Node/Python/security 无免提示直接读取权限，以及更新后的代码身份不能静默取得旧授权。这些真实条目验证没有包含在上述 18 组测试中。钥匙串锁定、app Node 更新或 helper 身份变化均须停止；不得通过扩大 ACL、关闭身份校验或导出密码解决。已有保存授权无需重复询问，超出该授权的权限变更需另行确认。
