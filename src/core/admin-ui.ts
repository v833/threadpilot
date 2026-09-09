/**
 * 管理页面:单文件原生 HTML/JS,由 agent-admin-api 在 GET / 托管。
 * 零 CDN(服务器在中国,外网脚本不可靠)、零构建管线,tsc 直接编译字符串常量。
 * 页面行为:输入访问令牌 → 拉取 agent 列表 → 逐 agent 编辑引擎模型
 * (baseUrl / apiKey / model / wireApi)与工作目录，可从供应商接口读取模型列表
 * → 保存(PUT)→ 展示是否已重启常驻引擎。
 */
export const ADMIN_UI_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="data:," />
<title>ThreadPilot 管理台</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px; font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #f5f6f8; color: #1f2328; line-height: 1.5;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #16181d; color: #e6e6e6; }
    .card { background: #1f242b; border-color: #303642; }
    input, select { background: #16181d; color: #e6e6e6; border-color: #3a4150; }
    .muted { color: #9aa3b2; }
    .tag { background: #2a303a; }
  }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #6a737d; font-size: 13px; margin-bottom: 20px; }
  .bar { display: flex; gap: 10px; align-items: center; margin-bottom: 20px; flex-wrap: wrap; }
  input, select {
    padding: 8px 10px; border: 1px solid #d0d7de; border-radius: 6px; font-size: 14px; background: #fff;
  }
  input[type="password"] { font-family: monospace; }
  button {
    padding: 8px 14px; border: 1px solid #d0d7de; border-radius: 6px; background: #f6f8fa;
    font-size: 14px; cursor: pointer;
  }
  button:hover { background: #eef1f4; }
  button.primary { background: #2f6fed; border-color: #2f6fed; color: #fff; }
  button.primary:hover { background: #285fd0; }
  button.danger { color: #c62828; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .card {
    background: #fff; border: 1px solid #d0d7de; border-radius: 10px; padding: 16px 18px;
    margin-bottom: 16px; max-width: 960px;
  }
  .card-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .card-head h2 { margin: 0; font-size: 16px; }
  .tag {
    font-size: 12px; padding: 2px 8px; border-radius: 999px; background: #eff1f3; color: #57606a;
  }
  .tag.enabled { background: #dafbe1; color: #116329; }
  .tag.override { background: #fff8c5; color: #7d4e00; }
  .muted { color: #6a737d; font-size: 13px; }
  .row { display: flex; gap: 10px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
  .field { display: flex; flex-direction: column; gap: 3px; }
  .field label { font-size: 12px; color: #6a737d; }
  .field input, .field select { min-width: 180px; }
  .model-control { display: flex; gap: 6px; align-items: center; }
  .model-control input { min-width: 220px; }
  .icon-button { width: 36px; height: 36px; padding: 0; font-size: 18px; }
  .engine-box {
    margin-top: 12px; border: 1px dashed #d0d7de; border-radius: 8px; padding: 12px;
  }
  .engine-box h3 { margin: 0 0 8px; font-size: 14px; }
  .hint { font-size: 12px; color: #6a737d; margin-top: 8px; }
  #toast {
    position: fixed; right: 20px; bottom: 20px; padding: 12px 16px; border-radius: 8px;
    background: #1f2328; color: #fff; font-size: 14px; opacity: 0; transition: opacity .2s;
    pointer-events: none; max-width: 420px;
  }
  #toast.show { opacity: 1; }
  #toast.error { background: #c62828; }
  #loading { margin: 40px 0; color: #6a737d; }
</style>
</head>
<body>
  <h1>🧭 ThreadPilot 管理台</h1>
  <div class="sub">管理 103 服务器上的 ThreadPilot:查看 / 配置每个 agent 的 codex / claude 引擎模型(baseUrl / API Key / model / wireApi)与工作目录。保存即热更新,受影响的常驻引擎会立即重启,下一次任务即用新配置。</div>

  <div class="bar">
    <input type="password" id="token" placeholder="访问令牌 (X-Api-Token)" style="min-width:220px" />
    <button class="primary" id="btn-connect">连接</button>
    <span class="muted" id="health"></span>
  </div>

  <div id="loading">加载中…</div>
  <div id="agents"></div>
  <div id="toast"></div>

<script>
(function () {
  var TOKEN_KEY = "tp-admin-token";
  var token = "";
  var agents = [];

  var $ = function (id) { return document.getElementById(id); };
  var toastEl = $("toast");
  var toastTimer = null;
  function toast(text, isError) {
    toastEl.textContent = text;
    toastEl.className = isError ? "show error" : "show";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = ""; }, 3500);
  }

  function loadToken() {
    try { token = localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { token = ""; }
    $("token").value = token;
  }
  function saveToken() {
    try { localStorage.setItem(TOKEN_KEY, token); } catch (e) { /* 私有模式等场景忽略 */ }
  }

  function api(method, path, body) {
    var headers = { "X-Api-Token": token };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(path, {
      method: method,
      headers: headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      if (res.status === 401) {
        toast("令牌无效,请重新输入", true);
        $("btn-connect").disabled = false;
        $("btn-connect").textContent = "连接";
        throw new Error("unauthorized");
      }
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || "请求失败 (" + res.status + ")");
        return data;
      });
    });
  }

  function connect() {
    token = $("token").value.trim();
    if (!token) { toast("请输入访问令牌", true); return; }
    saveToken();
    $("btn-connect").disabled = true;
    $("btn-connect").textContent = "连接中…";
    api("GET", "/api/health")
      .then(function () {
        $("health").textContent = "已连接";
        return api("GET", "/api/agents");
      })
      .then(function (data) { agents = data.agents || []; render(); })
      .catch(function (err) { if (err.message !== "unauthorized") toast(err.message, true); })
      .finally(function () {
        $("btn-connect").disabled = false;
        $("btn-connect").textContent = "连接";
      });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // 把空字符串字段剔除;引擎里没有任何字段时返回 undefined(表示无覆盖)。
  function normalizeEngines(engines) {
    var out = {};
    Object.keys(engines).forEach(function (engineId) {
      var e = engines[engineId];
      var clean = {};
      ["baseUrl", "apiKey", "model", "wireApi"].forEach(function (k) {
        var v = e[k];
        if (typeof v === "string" && v.trim() !== "") clean[k] = v.trim();
      });
      if (Object.keys(clean).length > 0) out[engineId] = clean;
    });
    return Object.keys(out).length > 0 ? out : undefined;
  }

  function engineForm(botId, engineId, cfg) {
    cfg = cfg || {};
    var hasKey = !!cfg.hasApiKey;
    var box = document.createElement("div");
    box.className = "engine-box";
    box.dataset.engine = engineId;

    var h3 = document.createElement("h3");
    h3.textContent = engineId + " 引擎";
    box.appendChild(h3);

    var row = document.createElement("div");
    row.className = "row";
    box.appendChild(row);

    function field(label, input) {
      var wrap = document.createElement("div");
      wrap.className = "field";
      var lab = document.createElement("label");
      lab.textContent = label;
      wrap.appendChild(lab);
      wrap.appendChild(input);
      row.appendChild(wrap);
    }

    var baseUrl = document.createElement("input");
    baseUrl.placeholder = "Base URL,如 https://api.example.com/v1";
    baseUrl.value = cfg.baseUrl || "";
    field("Base URL", baseUrl);

    var apiKey = document.createElement("input");
    apiKey.type = "password";
    apiKey.placeholder = hasKey ? "已配置(留空保持不变)" : "API Key(留空不配置)";
    field("API Key", apiKey);

    var model = document.createElement("input");
    model.placeholder = "Model,如 gpt-5.5";
    model.value = cfg.model || "";
    var modelList = document.createElement("datalist");
    var modelListId = "models-" + botId + "-" + engineId;
    modelList.id = modelListId;
    model.setAttribute("list", modelListId);
    var modelControl = document.createElement("div");
    modelControl.className = "model-control";
    modelControl.appendChild(model);
    modelControl.appendChild(modelList);
    var loadModels = document.createElement("button");
    loadModels.type = "button";
    loadModels.className = "icon-button";
    loadModels.textContent = "↻";
    loadModels.title = "从供应商获取模型列表";
    loadModels.setAttribute("aria-label", "从供应商获取模型列表");
    loadModels.addEventListener("click", function () {
      loadModels.disabled = true;
      api(
        "POST",
        "/api/agents/" + encodeURIComponent(botId) + "/engines/" + encodeURIComponent(engineId) + "/models",
        { baseUrl: baseUrl.value, apiKey: apiKey.value },
      )
        .then(function (data) {
          modelList.innerHTML = "";
          (data.models || []).forEach(function (id) {
            var option = document.createElement("option");
            option.value = id;
            modelList.appendChild(option);
          });
          toast("已获取 " + (data.models || []).length + " 个模型");
          model.focus();
        })
        .catch(function (err) { toast(err.message, true); })
        .finally(function () { loadModels.disabled = false; });
    });
    modelControl.appendChild(loadModels);
    field("Model", modelControl);

    if (engineId === "codex") {
      var wireApi = document.createElement("select");
      ["responses", "chat"].forEach(function (w) {
        var opt = document.createElement("option");
        opt.value = w;
        opt.textContent = w;
        opt.selected = (cfg.wireApi || "responses") === w;
        wireApi.appendChild(opt);
      });
      field("Wire API", wireApi);
    }

    var actions = document.createElement("div");
    actions.className = "row";
    box.appendChild(actions);

    var save = document.createElement("button");
    save.className = "primary";
    save.textContent = "保存引擎";
    save.addEventListener("click", function () {
      save.disabled = true;
      var engines = {};
      engines[engineId] = {
        baseUrl: baseUrl.value,
        apiKey: apiKey.value,
        model: model.value,
        wireApi: engineId === "codex" ? wireApi.value : undefined,
      };
      api("PUT", "/api/agents/" + encodeURIComponent(botId), { engines: engines })
        .then(function (data) {
          toast("已保存" + (data.restarted && data.restarted.length ? ",重启 " + data.restarted.join(", ") : ",下次任务生效"));
          refreshView(data.view);
        })
        .catch(function (err) { toast(err.message, true); })
        .finally(function () { save.disabled = false; });
    });
    actions.appendChild(save);

    var testConnection = document.createElement("button");
    testConnection.type = "button";
    testConnection.textContent = "测试连通性";
    testConnection.addEventListener("click", function () {
      testConnection.disabled = true;
      api(
        "POST",
        "/api/agents/" + encodeURIComponent(botId) + "/engines/" + encodeURIComponent(engineId) + "/test",
        {
          baseUrl: baseUrl.value,
          apiKey: apiKey.value,
          model: model.value,
          wireApi: engineId === "codex" ? wireApi.value : undefined,
        },
      )
        .then(function (data) {
          toast("模型连通成功，耗时 " + data.latencyMs + " ms");
        })
        .catch(function (err) { toast(err.message, true); })
        .finally(function () { testConnection.disabled = false; });
    });
    actions.appendChild(testConnection);

    if (cfg.baseUrl || cfg.model || hasKey) {
      var remove = document.createElement("button");
      remove.className = "danger";
      remove.textContent = "清除此引擎覆盖";
      remove.addEventListener("click", function () {
        remove.disabled = true;
        api("DELETE", "/api/agents/" + encodeURIComponent(botId) + "/engines/" + encodeURIComponent(engineId))
          .then(function (data) {
            toast("已清除 " + engineId + " 覆盖" + (data.restarted && data.restarted.length ? ",重启 " + data.restarted.join(", ") : ""));
            refreshView(data.view);
          })
          .catch(function (err) { toast(err.message, true); })
          .finally(function () { remove.disabled = false; });
      });
      actions.appendChild(remove);
    }

    return box;
  }

  function render() {
    var container = $("agents");
    container.innerHTML = "";
    $("loading").style.display = "none";
    if (!agents.length) {
      container.innerHTML = '<div class="muted">没有可管理的 agent(未命中 bots.json 的 bot 不会显示)。</div>';
      return;
    }
    agents.forEach(function (agent) {
      var card = document.createElement("div");
      card.className = "card";

      var head = document.createElement("div");
      head.className = "card-head";
      var h2 = document.createElement("h2");
      h2.textContent = agent.botId;
      head.appendChild(h2);
      var info = document.createElement("span");
      info.className = "muted";
      info.textContent = [agent.name, agent.role, "引擎: " + (agent.defaultCli || "-"), agent.accessMode].filter(Boolean).join(" · ");
      head.appendChild(info);
      card.appendChild(head);

      var ws = document.createElement("div");
      ws.className = "row";
      var wsLabel = document.createElement("span");
      wsLabel.className = "muted";
      wsLabel.textContent = "工作目录:";
      ws.appendChild(wsLabel);
      var wsInput = document.createElement("input");
      wsInput.style.minWidth = "320px";
      wsInput.value = agent.workspaceOverride || agent.workspace || "";
      wsInput.placeholder = "默认: " + (agent.workspace || "-");
      ws.appendChild(wsInput);
      var wsSave = document.createElement("button");
      wsSave.className = "primary";
      wsSave.textContent = agent.workspaceOverride ? "更新覆盖" : "设置覆盖";
      wsSave.addEventListener("click", function () {
        var v = wsInput.value.trim();
        if (!v) { toast("工作目录不能为空", true); return; }
        wsSave.disabled = true;
        api("PUT", "/api/agents/" + encodeURIComponent(agent.botId), { workspace: v })
          .then(function (data) {
            toast("已更新工作目录,新会话生效");
            refreshView(data.view);
          })
          .catch(function (err) { toast(err.message, true); })
          .finally(function () { wsSave.disabled = false; });
      });
      ws.appendChild(wsSave);
      if (agent.workspaceOverride) {
        var wsTag = document.createElement("span");
        wsTag.className = "tag override";
        wsTag.textContent = "覆盖中";
        ws.appendChild(wsTag);
        var wsClear = document.createElement("button");
        wsClear.className = "danger";
        wsClear.textContent = "恢复默认";
        wsClear.addEventListener("click", function () {
          wsClear.disabled = true;
          api("DELETE", "/api/agents/" + encodeURIComponent(agent.botId) + "/workspace")
            .then(function (data) { toast("已恢复默认工作目录"); refreshView(data.view); })
            .catch(function (err) { toast(err.message, true); })
            .finally(function () { wsClear.disabled = false; });
        });
        ws.appendChild(wsClear);
      }
      card.appendChild(ws);

      agent.engineIds.forEach(function (engineId) {
        card.appendChild(engineForm(agent.botId, engineId, (agent.engines || {})[engineId]));
      });

      var restart = document.createElement("button");
      restart.style.marginTop = "12px";
      restart.textContent = "重启此 agent 的常驻引擎";
      restart.addEventListener("click", function () {
        restart.disabled = true;
        api("POST", "/api/agents/" + encodeURIComponent(agent.botId) + "/restart")
          .then(function (data) {
            toast(data.note || "已重启 " + agent.botId);
            refreshView(data.view);
          })
          .catch(function (err) { toast(err.message, true); })
          .finally(function () { restart.disabled = false; });
      });
      card.appendChild(restart);

      container.appendChild(card);
    });
  }

  function refreshView(view) {
    agents = agents.map(function (a) { return a.botId === view.botId ? view : a; });
    render();
  }

  $("btn-connect").addEventListener("click", connect);
  $("token").addEventListener("keydown", function (e) { if (e.key === "Enter") connect(); });
  loadToken();
  if (token) connect();
})();
</script>
</body>
</html>
`;
