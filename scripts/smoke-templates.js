const { io } = require("socket.io-client");

const baseUrl = process.env.SMOKE_BASE_URL || "http://localhost:3000";
const candidates = [
  "https://tiermaker.com/create/---17780109",
  "https://tiermaker.com/create/anime-tier-list-210-animes-149921",
  "https://tiermaker.com/create/---------15773208?presentationMode=falsew/",
  "https://tiermaker.com/create/all-pokemon-tierlist-18823393",
  "https://tiermaker.com/create/all-mega-pokemon-new-17658378",
];

function timeout(ms, label) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} timeout`)), ms);
  });
}

async function joinRoom(roomId) {
  const socket = io(baseUrl, { transports: ["websocket"], reconnection: false });
  await Promise.race([
    new Promise((resolve, reject) => {
      socket.on("connect", resolve);
      socket.on("connect_error", reject);
    }),
    timeout(5000, "socket connect"),
  ]);

  try {
    return await Promise.race([
      new Promise((resolve, reject) => {
        socket.on("room:state", resolve);
        socket.on("room:error", reject);
        socket.emit("room:join", { roomId, nickname: "smoke-test" });
      }),
      timeout(7000, "room state"),
    ]);
  } finally {
    socket.disconnect();
  }
}

async function testTemplate(url) {
  const response = await fetch(`${baseUrl}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `import HTTP ${response.status}`);

  const room = await joinRoom(data.room.id);
  const imageChecks = [];
  for (const item of room.items.slice(0, Math.min(12, room.items.length))) {
    const imageResponse = await fetch(`${baseUrl}/api/image?url=${encodeURIComponent(item.src)}`);
    imageChecks.push({
      status: imageResponse.status,
      type: imageResponse.headers.get("content-type") || "",
    });
    if (imageResponse.ok) await imageResponse.arrayBuffer();
  }

  if (!data.existing) {
    await fetch(`${baseUrl}/api/rooms/${data.room.id}`, { method: "DELETE" }).catch(() => {});
  }

  const checked = imageChecks.length;
  const imageOk = imageChecks.filter((check) => check.status === 200 && check.type.startsWith("image/")).length;
  return {
    url,
    roomId: data.room.id,
    existing: Boolean(data.existing),
    title: room.title,
    items: room.items.length,
    tiers: room.tiers.length,
    imageOk,
    checked,
    statuses: imageChecks.map((check) => check.status),
  };
}

async function main() {
  const results = [];
  for (const url of candidates) {
    try {
      results.push({ ok: true, ...(await testTemplate(url)) });
    } catch (error) {
      results.push({ ok: false, url, error: error.message });
    }
  }

  console.log(JSON.stringify(results, null, 2));
  const failed = results.filter((result) => {
    const minimumOkImages = Math.min(4, result.checked || 0);
    return !result.ok || result.items < 4 || result.imageOk < minimumOkImages;
  });
  if (failed.length) {
    console.error(`Smoke failed for ${failed.length} template(s).`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
