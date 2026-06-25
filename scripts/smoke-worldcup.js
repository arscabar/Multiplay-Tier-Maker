const { io } = require("socket.io-client");

const baseUrl = process.env.SMOKE_BASE_URL || "http://localhost:3000";
const sampleUrl = process.env.SMOKE_PIKU_URL || "https://www.piku.co.kr/w/1bzrmf";
const searchTerm = process.env.SMOKE_PIKU_QUERY || "온라인 게임";

function timeout(ms, label) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} timeout`)), ms);
  });
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `${path} returned HTTP ${response.status}`);
  return data;
}

async function joinRoom(roomId, hostToken = "") {
  const socket = io(baseUrl, { transports: ["websocket"], reconnection: false });
  await Promise.race([
    new Promise((resolve, reject) => {
      socket.on("connect", resolve);
      socket.on("connect_error", reject);
    }),
    timeout(5000, "socket connect"),
  ]);

  const room = await Promise.race([
    new Promise((resolve, reject) => {
      socket.on("room:state", resolve);
      socket.on("room:error", reject);
      socket.emit("room:join", { roomId, nickname: "worldcup-smoke", hostToken });
    }),
    timeout(7000, "room state"),
  ]);

  return { socket, room };
}

async function emitWithAck(socket, eventName, payload) {
  return Promise.race([
    new Promise((resolve) => socket.emit(eventName, payload, resolve)),
    timeout(7000, `${eventName} ack`),
  ]);
}

async function assertImageProxy(items) {
  const checks = [];
  for (const item of items.slice(0, Math.min(8, items.length))) {
    const imageResponse = await fetch(`${baseUrl}/api/image?url=${encodeURIComponent(item.src)}`);
    checks.push({
      status: imageResponse.status,
      type: imageResponse.headers.get("content-type") || "",
    });
    if (imageResponse.ok) await imageResponse.arrayBuffer();
  }

  const imageOk = checks.filter((check) => check.status === 200 && check.type.startsWith("image/")).length;
  if (imageOk < Math.min(4, checks.length)) {
    throw new Error(`image proxy failed: ${JSON.stringify(checks)}`);
  }
  return { imageOk, checked: checks.length };
}

async function testSearchAndPreview() {
  const search = await requestJson(`/api/templates/search?mode=worldcup&q=${encodeURIComponent(searchTerm)}`);
  if (!Array.isArray(search.templates) || !search.templates.length) {
    throw new Error("PIKU search returned no templates");
  }

  const preview = await requestJson(
    `/api/templates/preview?mode=worldcup&url=${encodeURIComponent(sampleUrl)}`
  );
  const options = preview.template?.bracketOptions || [];
  const sizes = options.map((option) => Number(option.size)).filter(Boolean);
  if (!sizes.some((size) => size >= 512)) {
    throw new Error(`preview did not expose large bracket options: ${sizes.join(", ")}`);
  }

  return {
    searchResults: search.templates.length,
    previewTitle: preview.template.title,
    previewOptions: sizes,
  };
}

async function createWorldcupRoom(bracketSize) {
  const data = await requestJson("/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: sampleUrl, mode: "worldcup", bracketSize }),
  });
  return data;
}

async function testWorldcupRoom(bracketSize) {
  const data = await createWorldcupRoom(bracketSize);
  const { socket, room } = await joinRoom(data.room.id, data.hostToken);
  try {
    if (room.mode !== "worldcup") throw new Error(`expected worldcup room, got ${room.mode}`);
    if (room.items.length !== bracketSize) {
      throw new Error(`expected ${bracketSize} items, got ${room.items.length}`);
    }
    const pair = room.worldcup?.currentPair || [];
    if (pair.length !== 2) throw new Error("worldcup pair was not prepared");

    const imageResult = await assertImageProxy(room.items);
    const vote = await emitWithAck(socket, "worldcup:vote", { itemId: pair[0] });
    if (!vote?.ok) throw new Error(vote?.message || "worldcup vote was rejected");

    if (!data.existing) {
      await fetch(`${baseUrl}/api/rooms/${data.room.id}`, {
        method: "DELETE",
        headers: data.hostToken ? { "x-host-token": data.hostToken } : {},
      }).catch(() => {});
    }

    return {
      roomId: data.room.id,
      title: room.title,
      bracketSize,
      items: room.items.length,
      imageOk: imageResult.imageOk,
      checked: imageResult.checked,
      voteOk: true,
    };
  } finally {
    socket.disconnect();
  }
}

async function main() {
  const results = {
    search: await testSearchAndPreview(),
    rooms: [],
  };
  results.rooms.push(await testWorldcupRoom(16));
  results.rooms.push(await testWorldcupRoom(512));

  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
