const sources = {
  monosans: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
  speedx: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
  proxyscrape: "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=8000&ssl=yes",
  roosterkid: "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt",
  clarketm: "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt",
  mmpx12: "https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt",
  proxyspace: "https://proxyspace.pro/http.txt",
  openproxylist: "https://openproxylist.xyz/http.txt",
};
const { ProxyAgent, request } = await import("undici");
async function checkProxy(p) {
  try {
    const r = await request("https://api.ipify.org/?format=text", {
      dispatcher: new ProxyAgent({ uri: `http://${p}`, connectTimeout: 6000, headersTimeout: 8000, bodyTimeout: 8000 }),
    });
    const ok = r.statusCode === 200;
    r.body.dump();
    return ok;
  } catch { return false; }
}
for (const [name, url] of Object.entries(sources)) {
  let text = "";
  try { text = await (await fetch(url, { signal: AbortSignal.timeout(15000) })).text(); } catch (e) { console.log(`${name}: FETCH FAIL ${e.message}`); continue; }
  const proxies = text.split("\n").map(l => l.trim()).filter(l => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l));
  // random sample of 25
  const sample = proxies.sort(() => Math.random() - 0.5).slice(0, 25);
  const results = await Promise.all(sample.map(checkProxy));
  const good = results.filter(Boolean).length;
  console.log(`${name}: pool=${proxies.length} sampleOK=${good}/25`);
}
