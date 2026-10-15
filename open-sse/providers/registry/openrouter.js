export default {
  id: "openrouter",
  priority: 10,
  hasFree: true,
  alias: "openrouter",
  display: {
    name: "OpenRouter",
    icon: "router",
    color: "#F97316",
    textIcon: "OR",
    website: "https://openrouter.ai",
    notice: {
      text: "Free tier: 27+ free models, no credit card needed, 200 req/day. After  0 credit: 1,000 req/day.",
      apiKeyUrl: "https://openrouter.ai/settings/keys",
    },
  },
  category: "freeTier",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    thinkingFormat: "openai",
    headers: {
      "HTTP-Referer": "https://endpoint-proxy.local",
      "X-Title": "Endpoint Proxy",
    },
  },
  models: [
    { id: "typesafe/jev-1.13", name: "Jev 1.13", kind: "systemone" },
  ],
  serviceKinds: ["llm","imageToText","systemone"],
  // System One decision API (TypeSafe-compatible): https://openrouter.ai/docs/guides/community/typesafe-sdk
  systemoneConfig: {
    baseUrl: "https://openrouter.ai/api/v1/systemone",
    headers: {"HTTP-Referer":"https://endpoint-proxy.local","X-Title":"Endpoint Proxy"},
  },
  modelsFetcher: { url: "https://openrouter.ai/api/v1/models", type: "openrouter-free" },
  passthroughModels: true,
};
