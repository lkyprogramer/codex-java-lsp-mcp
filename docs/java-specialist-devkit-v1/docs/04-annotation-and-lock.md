# 标注、锁定集与防污染

每条gold必须经过：源码对照→目标声明定位→最小必要证据解释→QA值类型检查/repair断言→独立复核。当前包完成前四项，其中“源码对照”为单作者审阅；独立复核状态仍为 source_checked_single_author，不虚构双人一致率。

## 标注边界

答案约定严格JSON键/类型/值。数组顺序有语义时按提示顺序，无语义集合在提示中规定按字母序。不得以LLM模糊judge把错误答案放行。字符串如Set<String>是声明类型，不接受把实现HashSet当同义正确答案。需要自由文本时新增人工rubric层，不改变当前结构化契约。

required范围要能由源码直接支持；不因某个检索器偏好而选行。注释与实际实现不一致时按任务要求区分；如pricing实际DOWN而契约HALF_UP，QA问实际行为，repair问修复契约。

当一种正确证明路径未在required里标注，候选可能遭误罚。先提交标签异议，不让执行AI自行删除gold要求。若接受异议，升级数据版本、修改两臂的相同标签并保存旧结果。annotated precision只能作为下界代理，不宣称所有未标注行都是噪声。

## locked政策

split按整个语料cluster划分，避免同一业务3任务分散到dev/locked。锁定指禁止调参使用，不代表未被构造作者看到。包内明文gold必须交所有者保管；运行Agent只挂载 stage 目录和所需工具，evaluator通过外部进程持有gold/冻结测试。

同用户权限的临时目录隔离不是安全沙箱。严肃盲测使用独立OS用户/容器bind mount/权限策略，只挂载任务repo与prompt，禁止向上浏览kit。模型上下文中也不得出现参考补丁、旧报告或gold。stage工具的防泄漏只保证文件复制内容，不限制Agent额外读取宿主文件。

记录 exposure.json：谁、何时、看过哪个split/答案、调过什么规则。locked一旦被用于调参就转regression；补入未见的新锁定cluster，不把同义改写充当新题。

## 不计入独立数量

中英query、repeat、mutation、同一方法的调参运行、负对照和oracle自检均不能增加task_group数。按task折叠variants/repeats，再按corpus cluster bootstrap；locked仅4cluster，区间和显著性结论非常有限。
