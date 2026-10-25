# Work / Browser 独立加载边界

Work 与 Browser 是两个独立的内容宿主。布局可以共享，导航和加载生命周期由各列自己拥有。

## 状态归属

| 状态 | 所有者 | 可触发重新加载的原因 |
| --- | --- | --- |
| Work 当前目标、请求版本、加载失败 | Work navigation / Work surface | Work 导航、明确重试、对应资源变化 |
| Browser 当前内容、前进后退历史 | Browser store / Browser surface | Browser 打开、历史导航、明确重试、对应资源变化 |
| 内容 loading / ready / error | 实际内容 renderer，通过自己的 viewId 上报 | 自己的资源请求和解析结果 |
| 未知文件类型、集合地址解析、不可用状态 | FileBrowserRenderer 外壳 | 自己的解析任务和目标变化 |
| 列宽、工具栏配置、焦点 | Shell / Focus store | 只更新布局与交互，不启动资源请求 |
| 文件身份、正文缓冲、保存队列 | Document session / display registry | 同一资源的数据一致性，不传播其他宿主的加载状态 |

## 导航规则

- 侧边栏导航和笔记本选择只替换 Work；Browser 保留自己的当前内容、笔记本上下文及历史。
- Work 和 Browser 不共用导航队列或 loading 标志。普通 Work 导航不等待无关 Browser 的保存或加载。
- 只有同一内容需要建立第二个可编辑视图时，才经过已有的跨宿主保存协调。
- 焦点转移可以发布编辑草稿、改变编辑权限，不能重新读取文件或重建网页 iframe。
- 文件删除、改名和真实内容变更仍按资源身份通知相关宿主；独立加载不等于忽略外部变更。

## 渲染规则

Browser 的 surface 描述只依赖自己的 entry、网页 runtime 和显示配置，保持引用稳定。
Browser 内容宿主通过 memo 隔离主布局的无关重渲染；焦点和 Browser 自身目标更新仍正常传播。

FileBrowserRenderer 完成类型和地址解析后，只发布外观与能力，不再把内容状态重置为 loading。
初始 loading 由宿主的 surface 注册和各自的 Suspense 边界处理；实际内容 renderer 独占后续加载结果。
这样切换焦点、重新绑定展示回调、更新 Work 均不会制造一次虚假的阻塞加载。

## 回归保障

- 文件外壳重渲染后不重复上报 loading，保留编辑器 DOM、草稿和滚动位置，资源读取次数不增加。
- Work loading、失败、提交期间，Browser iframe、URL、历史和 ready 状态保持不变。
- Browser 导航不改变 Work 的导航事务。
- 切换笔记本不清空 Browser，也不调用无关 Browser 的 flush；Work 自己保存失败仍阻止切换。
