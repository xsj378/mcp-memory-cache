# mcp-memory-cache
A memory cache server designed to support MCP API clients. Its core goal is to reduce token consumption during language model interaction by efficiently caching data, thereby improving performance and response speed.

## 一、项目简介

**ib-mcp-cache-server** 是一个为支持 MCP API 客户端设计的内存缓存服务器。其核心目标是通过高效缓存数据，减少语言模型交互过程中的 token 消耗，从而提升性能和响应速度。该服务支持任何基于 MCP 协议的客户端和模型。

## 二、技术架构
### 2.1 核心模块
1.CacheManager（CacheManager.ts）
- 功能：负责内存缓存的增删查改、过期、LRU淘汰、统计等。
- 实现：
   * 用 Map<string, CacheEntry> 存储缓存数据。
   * 支持最大条数、最大内存、TTL、定期清理等配置。
   * 每次 set/delete 时会通过 sendSseEvent 推送 SSE 通知。
   * 统计命中率、miss、hit、平均访问时间等。

2.MCP 协议集成（index.ts）
- 功能：对接 MCP 协议，支持 stdio agent、本地 HTTP agent、SSE。
- 实现：
   * 通过 @modelcontextprotocol/sdk 的 Server 实例注册 MCP 工具（如 store_data、retrieve_data、clear_cache、get_cache_stats）。
   * 支持 MCP stdio agent（本地进程通信）。
   * 支持 MCP HTTP agent（/mcp 路由，HTTP POST，标准 MCP 协议）。
   * 支持 SSE（/events 路由，推送缓存变动）。

3.SSE 实现（index.ts）
- 功能：实时推送缓存变动事件给所有连接的客户端。
- 实现：
   * 维护 sseClients 客户端列表。
   * 缓存 set/delete 时调用 sendSseEvent，向所有 SSE 客户端推送事件。

### 2.2 调用链
<p align="center">
  <img src="调用链.png" alt="调用链" />
</p>

### 2.3 类图
<p align="center">
  <img src="类图1.png" alt="类图" />
</p>

## 三、评估目标

1. 验证缓存服务器对 token 消耗的实际降低效果。
2. 评估缓存命中率、内存占用、响应延迟等关键性能指标。

## 四、评估指标与方法

### 4.1 Token 消耗对比

**方法**：在有无缓存服务器的情况下，分别执行多次相同的文件读取、数据分析等操作，统计 token 消耗量。

**指标**：token 总消耗量、节省百分比。

**实验设置**：
- 文件内容：
   ```
   这是一个用于MCP缓存测试的大型文本文件。

   Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.

   （可根据需要复制多段内容以增加文件体积）

   The quick brown fox jumps over the lazy dog.

   数据行1：1234567890
   数据行2：abcdefghij
   数据行3：!@#$%^&*()_+

   End of test file.
   ```
- 输入：读取并分析这个文件，告诉我这个文件是做什么的，用mcp缓存结果。最后告诉我token消耗。
- 模型选择：Deepseek-V3

实验结果：

| 场景         | 操作次数 | 无缓存总Token | 有缓存总Token | 节省Token | 节省百分比 |
|--------------|----------|--------------|--------------|-----------|------------|
| 读取分析文件    | 5        | 6000         | 1640        | 4360      | 72.7%        |
| 文件B分析    | 3        | 4011         | 1477         | 2534      | 63.2%        |

### 4.2 缓存命中率

- **方法**：通过服务器统计接口或日志，收集一段时间内的缓存命中与未命中次数。
- **指标**：命中率 = 命中次数 / 总请求次数。
- **实验结果**：在实验Token消耗对比设置下，结果如下：
   * 总缓存条目：4
   * 内存使用量：1574 bytes
   * 命中次数：17
   * 未命中次数：1
   * 命中率：94.4%

### 4.3 响应延迟

- **方法**：测量同一操作在首次请求和后续请求中的响应时间差异。
- **实验结果**：
   * 存储操作：1.8ms (键值写入)
   * 检索操作：1.2ms (键值读取)
   * 平均延迟：1.5ms (低于基准2.0ms)
   * 峰值延迟：3.4ms (发生在多键并发请求时)

## 五、优化建议

- 根据实际业务场景调整 TTL 和内存上限，提升缓存命中率。
- 定期监控缓存统计数据，及时调整配置。
- 对于频繁变更的数据，适当缩短 TTL，避免数据不一致。

## 六、结论

ib-mcp-cache-server 能有效降低 token 消耗、提升响应速度，并具备良好的配置灵活性和稳定性。

---

**参考资料：**  
- [ib-mcp-cache-server GitHub 仓库](https://github.com/ibproduct/ib-mcp-cache-server)

