# 医疗 AI 本地演示

需要 Node.js 20 或更新版本，无需 npm install。

1. 点击仓库 Code → Download ZIP 并解压。
2. 将 keys.local.example.json 复制为 keys.local.json，填写两个 API Key：qa 对应健康助手，model 对应医疗基模。
3. 在解压目录打开终端，运行 npm start。
4. 浏览器打开 http://127.0.0.1:3000 ，保持终端运行。

也可使用 MEDICAL_QA_API_KEY 和 MEDICAL_MODEL_API_KEY 环境变量配置。未配置服务端密钥时，可在页面输入各服务的 Key。页面输入的 Key 保存在浏览器 localStorage，可在页面清除。

服务仅监听本机，按服务自动选择对应密钥，不向页面返回服务端密钥。不要提交 keys.local.json 或含真实密钥的 ZIP。

支持医疗助手、医疗基模、流式对话及 medical-vl 图片输入，实际权限取决于账号和上游接口。需要能访问 https://zx-dsc.sm.cn。

运行测试：node --test server.test.js demo.test.js。本地模拟测试通过不代表真实上游可用。AI 回答仅供参考，不能替代医生诊断。
