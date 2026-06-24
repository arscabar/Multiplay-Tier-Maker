const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const express = require("express");
const cheerio = require("cheerio");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 3000);
const PLAYER_COLORS = [
  "#2dd4bf",
  "#f9734d",
  "#f4c95d",
  "#a78bfa",
  "#5eead4",
  "#fb7185",
  "#84cc16",
  "#38bdf8",
];
const TIER_COLORS = [
  "#ef4444",
  "#f97316",
  "#facc15",
  "#84cc16",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#a855f7",
  "#64748b",
];
const MAX_CUSTOM_ITEM_DATA_URL_LENGTH = 900_000;
const MAX_CUSTOM_ITEM_ALT_LENGTH = 48;
const MAX_CUSTOM_TIER_LABEL_LENGTH = 32;
const MAX_SNAPSHOT_ITEMS = 3000;
const MAX_SNAPSHOT_TIERS = 32;
const MAX_SNAPSHOT_TITLE_LENGTH = 140;
const MAX_HTML_IMPORT_LENGTH = 8_000_000;
const IMAGE_CACHE_TTL_MS = 1000 * 60 * 60;
const IMAGE_FETCH_TIMEOUT_MS = 15_000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const rooms = new Map();
const socketRooms = new Map();
const imageCache = new Map();

app.use(express.json({ limit: "10mb" }));
app.use((req, res, next) => {
  const origin = String(req.headers.origin || "");
  if (/^https:\/\/(?:www\.)?tiermaker\.com$/i.test(origin) || /^chrome-extension:\/\//i.test(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-methods", "POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-allow-private-network", "true");
    res.setHeader("vary", "Origin");
  }

  if (req.method === "OPTIONS" && req.path === "/api/rooms/snapshot") {
    res.sendStatus(204);
    return;
  }

  next();
});
app.use(
  express.static(path.join(__dirname, "public"), {
    etag: false,
    maxAge: 0,
    setHeaders: (res) => {
      res.setHeader("cache-control", "no-store");
    },
  })
);

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/config", (_req, res) => {
  res.json({
    publicBaseUrl: getPublicBaseUrl(),
  });
});

app.get("/api/rooms", (_req, res) => {
  res.json({ rooms: serializeRooms() });
});

app.get("/api/templates/search", async (req, res) => {
  try {
    const query = String(req.query.q || "").trim().slice(0, 80);
    const category = normalizeSearchCategory(req.query.category);
    const templates = await searchTierMakerTemplates(query, category);
    res.json({ templates });
  } catch (error) {
    res.status(502).json({
      message: error.message || "TierMaker 템플릿을 찾지 못했습니다.",
    });
  }
});

app.get("/api/templates/preview", async (req, res) => {
  try {
    const sourceUrl = normalizeTierMakerUrl(req.query?.url);
    const template = await importTierMakerTemplate(sourceUrl);
    res.json({ template: serializeTemplatePreview(template) });
  } catch (error) {
    res.status(422).json({
      message: error.message || "템플릿 미리보기를 불러오지 못했습니다.",
    });
  }
});

app.post("/api/rooms", async (req, res) => {
  try {
    const sourceUrl = normalizeTierMakerUrl(req.body?.url);
    const sourceKey = createSourceKey(sourceUrl);
    const existingRoom = findRoomBySourceKey(sourceKey);
    if (existingRoom) {
      existingRoom.updatedAt = Date.now();
      io.emit("rooms:update", serializeRooms());
      res.status(200).json({ existing: true, room: serializeRoomSummary(existingRoom) });
      return;
    }

    const template = await importTierMakerTemplate(sourceUrl);
    template.sourceKey = sourceKey;
    const room = createRoom(template);
    io.emit("rooms:update", serializeRooms());
    res.status(201).json({ existing: false, room: serializeRoomSummary(room) });
  } catch (error) {
    res.status(422).json({
      message: error.message || "티어메이커 링크를 가져오지 못했습니다.",
    });
  }
});

app.post("/api/rooms/snapshot", (req, res) => {
  try {
    const template = buildTemplateFromSnapshot(req.body);
    const existingRoom = findRoomBySourceKey(template.sourceKey);
    if (existingRoom) {
      existingRoom.updatedAt = Date.now();
      io.emit("rooms:update", serializeRooms());
      res.status(200).json({ existing: true, room: serializeRoomSummary(existingRoom) });
      return;
    }

    const room = createRoom(template);
    io.emit("rooms:update", serializeRooms());
    res.status(201).json({ existing: false, room: serializeRoomSummary(room) });
  } catch (error) {
    res.status(422).json({
      message: error.message || "원본 페이지에서 템플릿을 가져오지 못했습니다.",
    });
  }
});

app.post("/api/rooms/html", (req, res) => {
  try {
    const sourceUrl = normalizeTierMakerUrl(req.body?.url);
    const html = String(req.body?.html || "");
    if (!html.trim()) throw new Error("TierMaker 페이지 HTML을 붙여넣어주세요.");
    if (html.length > MAX_HTML_IMPORT_LENGTH) throw new Error("HTML이 너무 큽니다. 페이지 소스만 붙여넣어주세요.");

    const sourceKey = createSourceKey(sourceUrl);
    const existingRoom = findRoomBySourceKey(sourceKey);
    if (existingRoom) {
      existingRoom.updatedAt = Date.now();
      io.emit("rooms:update", serializeRooms());
      res.status(200).json({ existing: true, room: serializeRoomSummary(existingRoom) });
      return;
    }

    const template = parseTierMakerHtml(html, sourceUrl);
    template.sourceKey = sourceKey;
    if (!template.items.length) {
      throw new Error("HTML에서 템플릿 이미지를 찾지 못했습니다.");
    }

    const room = createRoom(template);
    io.emit("rooms:update", serializeRooms());
    res.status(201).json({ existing: false, room: serializeRoomSummary(room) });
  } catch (error) {
    res.status(422).json({
      message: error.message || "페이지 HTML에서 템플릿을 가져오지 못했습니다.",
    });
  }
});

app.delete("/api/rooms/:roomId", async (req, res) => {
  const deleted = await deleteRoom(String(req.params.roomId || ""));
  if (!deleted) {
    res.status(404).json({ message: "방을 찾을 수 없습니다." });
    return;
  }

  res.json({ ok: true });
});

app.get("/api/image", async (req, res) => {
  try {
    const rawUrl = String(req.query.url || "");
    const imageUrl = normalizeTemplateImageUrl(rawUrl);
    if (!imageUrl) {
      res.status(400).send("Only TierMaker images can be proxied.");
      return;
    }

    const cached = imageCache.get(imageUrl);
    if (cached && cached.expiresAt > Date.now()) {
      sendCachedImage(res, cached);
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
    const upstream = await fetch(imageUrl, {
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
        accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        referer: "https://tiermaker.com/",
      },
    }).finally(() => clearTimeout(timeout));

    if (!upstream.ok) {
      res.status(upstream.status).send("Image fetch failed.");
      return;
    }

    const contentType = upstream.headers.get("content-type") || "image/png";
    if (!contentType.startsWith("image/")) {
      res.status(502).send("Image fetch returned non-image content.");
      return;
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    const cachedImage = {
      buffer,
      contentType,
      expiresAt: Date.now() + IMAGE_CACHE_TTL_MS,
    };
    imageCache.set(imageUrl, cachedImage);
    sendCachedImage(res, cachedImage);
  } catch (error) {
    if (error?.name === "AbortError") {
      res.status(504).send("Image fetch timed out.");
      return;
    }
    res.status(400).send("Invalid image URL.");
  }
});

io.on("connection", (socket) => {
  socket.emit("rooms:update", serializeRooms());

  socket.on("room:join", ({ roomId, nickname }) => {
    const room = rooms.get(String(roomId || ""));
    if (!room) {
      socket.emit("room:error", { message: "방을 찾을 수 없습니다." });
      return;
    }

    leaveCurrentRoom(socket);

    const player = {
      id: socket.id,
      nickname: sanitizeNickname(nickname),
      color: PLAYER_COLORS[room.playerColorIndex % PLAYER_COLORS.length],
      cursor: null,
      joinedAt: Date.now(),
    };

    room.playerColorIndex += 1;
    room.players[socket.id] = player;
    room.updatedAt = Date.now();
    socketRooms.set(socket.id, room.id);
    socket.join(room.id);
    io.to(room.id).emit("room:state", serializeRoom(room));
    io.emit("rooms:update", serializeRooms());
  });

  socket.on("room:leave", () => {
    leaveCurrentRoom(socket);
  });

  socket.on("room:delete", async ({ roomId }) => {
    const targetRoomId = String(roomId || socketRooms.get(socket.id) || "");
    await deleteRoom(targetRoomId);
  });

  socket.on("item:move", ({ itemId, laneId, beforeId }) => {
    const room = getSocketRoom(socket);
    if (!room) return;
    const changed = moveItem(room, String(itemId || ""), String(laneId || ""), beforeId);
    if (changed) {
      io.to(room.id).emit("room:state", serializeRoom(room));
      io.emit("rooms:update", serializeRooms());
    }
  });

  socket.on("item:add", ({ src, alt }, reply) => {
    const room = getSocketRoom(socket);
    const respond = typeof reply === "function" ? reply : () => {};
    if (!room) {
      respond({ ok: false, message: "방에 먼저 입장해주세요." });
      return;
    }

    const item = createCustomItem(src, alt);
    if (!item) {
      respond({ ok: false, message: "이미지 또는 항목 데이터를 확인해주세요." });
      return;
    }

    item.laneId = "pool";
    item.order = nextLaneOrder(room, "pool");
    room.items.push(item);
    room.updatedAt = Date.now();
    io.to(room.id).emit("room:state", serializeRoom(room));
    io.emit("rooms:update", serializeRooms());
    respond({ ok: true, itemId: item.id });
  });

  socket.on("tier:add", ({ label }, reply) => {
    const room = getSocketRoom(socket);
    const respond = typeof reply === "function" ? reply : () => {};
    if (!room) {
      respond({ ok: false, message: "방에 먼저 입장해주세요." });
      return;
    }

    const tier = createCustomTier(room, label);
    if (!tier) {
      respond({ ok: false, message: "티어 이름을 입력해주세요." });
      return;
    }

    room.template.tiers.push(tier);
    room.updatedAt = Date.now();
    io.to(room.id).emit("room:state", serializeRoom(room));
    io.emit("rooms:update", serializeRooms());
    respond({ ok: true, tierId: tier.id });
  });

  socket.on("tier:move", ({ tierId, beforeId }) => {
    const room = getSocketRoom(socket);
    if (!room) return;
    const changed = moveTier(room, String(tierId || ""), beforeId ? String(beforeId) : null);
    if (changed) {
      room.updatedAt = Date.now();
      io.to(room.id).emit("room:state", serializeRoom(room));
      io.emit("rooms:update", serializeRooms());
    }
  });

  socket.on("item:focus", ({ itemId }) => {
    const room = getSocketRoom(socket);
    if (!room || !room.players[socket.id]) return;

    if (!room.activeItems) room.activeItems = {};
    const normalizedItemId = String(itemId || "");
    const itemExists = room.items.some((item) => item.id === normalizedItemId);

    if (!itemExists) {
      delete room.activeItems[socket.id];
    } else {
      const player = room.players[socket.id];
      room.activeItems[socket.id] = {
        itemId: normalizedItemId,
        playerId: socket.id,
        nickname: player.nickname,
        color: player.color,
      };
    }

    io.to(room.id).emit("item:focus", {
      activeItems: Object.values(room.activeItems),
    });
  });

  socket.on("room:reset", () => {
    const room = getSocketRoom(socket);
    if (!room) return;
    room.activeItems = {};
    room.items.forEach((item, index) => {
      item.laneId = "pool";
      item.order = index;
    });
    room.updatedAt = Date.now();
    io.to(room.id).emit("room:state", serializeRoom(room));
  });

  socket.on("cursor:move", ({ mode, x, y }) => {
    const room = getSocketRoom(socket);
    if (!room || !room.players[socket.id]) return;
    const cursor = {
      mode: mode === "board" ? "board" : "page",
      x: clampNumber(x, 0, 10000),
      y: clampNumber(y, 0, 10000),
      at: Date.now(),
    };
    room.players[socket.id].cursor = cursor;
    socket.to(room.id).emit("cursor:update", {
      playerId: socket.id,
      nickname: room.players[socket.id].nickname,
      color: room.players[socket.id].color,
      cursor,
    });
  });

  socket.on("disconnect", () => {
    leaveCurrentRoom(socket);
  });
});

server.listen(PORT, () => {
  console.log(`MultiplayTierMaker running at http://localhost:${PORT}`);
});

function getSocketRoom(socket) {
  const roomId = socketRooms.get(socket.id);
  if (!roomId) return null;
  return rooms.get(roomId) || null;
}

function leaveCurrentRoom(socket) {
  const roomId = socketRooms.get(socket.id);
  if (!roomId) return;
  const room = rooms.get(roomId);
  socket.leave(roomId);
  socketRooms.delete(socket.id);

  if (room) {
    delete room.players[socket.id];
    if (room.activeItems) delete room.activeItems[socket.id];
    room.updatedAt = Date.now();
    io.to(room.id).emit("room:state", serializeRoom(room));
    io.to(room.id).emit("cursor:remove", { playerId: socket.id });
    io.emit("rooms:update", serializeRooms());
  }
}

function createRoom(template) {
  let id = "";
  do {
    id = crypto.randomBytes(3).toString("hex").toUpperCase();
  } while (rooms.has(id));

  const room = {
    id,
    template,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    playerColorIndex: 0,
    players: {},
    activeItems: {},
    items: template.items.map((item, index) => ({
      ...item,
      laneId: "pool",
      order: index,
    })),
  };

  rooms.set(id, room);
  return room;
}

async function deleteRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return false;

  io.to(roomId).emit("room:deleted", { roomId });
  rooms.delete(roomId);

  for (const [socketId, joinedRoomId] of socketRooms.entries()) {
    if (joinedRoomId === roomId) {
      socketRooms.delete(socketId);
    }
  }

  const sockets = await io.in(roomId).fetchSockets();
  sockets.forEach((socket) => {
    socket.leave(roomId);
  });

  io.emit("rooms:update", serializeRooms());
  return true;
}

function findRoomBySourceKey(sourceKey) {
  for (const room of rooms.values()) {
    const roomSourceKey = room.template.sourceKey || createSourceKey(room.template.sourceUrl || "");
    if (roomSourceKey === sourceKey) return room;
  }
  return null;
}

function serializeRooms() {
  return Array.from(rooms.values())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(serializeRoomSummary);
}

function serializeRoomSummary(room) {
  return {
    id: room.id,
    title: room.template.title,
    imageCount: room.items.length,
    tierCount: room.template.tiers.length,
    playerCount: Object.keys(room.players).length,
    players: serializePlayers(room),
    sourceUrl: room.template.sourceUrl,
    updatedAt: room.updatedAt,
  };
}

function serializeRoom(room) {
  return {
    ...serializeRoomSummary(room),
    tiers: room.template.tiers,
    activeItems: Object.values(room.activeItems || {}),
    items: room.items
      .slice()
      .sort((a, b) => a.laneId.localeCompare(b.laneId) || a.order - b.order),
    players: serializePlayers(room),
  };
}

function serializePlayers(room) {
  return Object.values(room.players).map((player) => ({
    id: player.id,
    nickname: player.nickname,
    color: player.color,
  }));
}

function serializeTemplatePreview(template) {
  return {
    title: template.title,
    sourceUrl: template.sourceUrl,
    imageCount: template.items.length,
    tierCount: template.tiers.length,
    tiers: template.tiers.slice(0, 10).map((tier) => ({
      label: tier.label,
      color: tier.color,
    })),
    items: template.items.slice(0, 12).map((item) => ({
      src: item.src,
      alt: item.alt,
    })),
  };
}

function moveItem(room, itemId, targetLaneId, beforeId) {
  const item = room.items.find((entry) => entry.id === itemId);
  const validLaneIds = new Set(["pool", ...room.template.tiers.map((tier) => tier.id)]);
  if (!item || !validLaneIds.has(targetLaneId)) return false;

  const previousLaneId = item.laneId;
  item.laneId = targetLaneId;

  const targetItems = room.items
    .filter((entry) => entry.laneId === targetLaneId && entry.id !== itemId)
    .sort((a, b) => a.order - b.order);

  let insertIndex = targetItems.length;
  if (beforeId) {
    const beforeIndex = targetItems.findIndex((entry) => entry.id === beforeId);
    if (beforeIndex >= 0) insertIndex = beforeIndex;
  }

  targetItems.splice(insertIndex, 0, item);
  reindexLane(room, previousLaneId);
  reindexLane(room, targetLaneId, targetItems);
  room.updatedAt = Date.now();
  return true;
}

function moveTier(room, tierId, beforeId) {
  const tiers = room.template.tiers;
  const fromIndex = tiers.findIndex((tier) => tier.id === tierId);
  if (fromIndex < 0 || tierId === beforeId) return false;

  const previousOrder = tiers.map((tier) => tier.id).join("|");
  const [tier] = tiers.splice(fromIndex, 1);
  let toIndex = beforeId ? tiers.findIndex((entry) => entry.id === beforeId) : tiers.length;
  if (toIndex < 0) toIndex = tiers.length;
  tiers.splice(toIndex, 0, tier);
  return previousOrder !== tiers.map((entry) => entry.id).join("|");
}

function createCustomItem(src, alt) {
  const source = String(src || "");
  if (!isAllowedCustomImageDataUrl(source)) return null;

  const label = String(alt || "사용자 추가 항목")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CUSTOM_ITEM_ALT_LENGTH);

  return {
    id: `custom-${crypto.randomBytes(6).toString("hex")}`,
    src: source,
    alt: label || "사용자 추가 항목",
  };
}

function createCustomTier(room, label) {
  const cleanLabel = String(label || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CUSTOM_TIER_LABEL_LENGTH);
  if (!cleanLabel) return null;

  const index = room.template.tiers.length;
  return {
    id: `tier-custom-${crypto.randomBytes(5).toString("hex")}`,
    label: cleanLabel,
    color: TIER_COLORS[index % TIER_COLORS.length],
  };
}

function isAllowedCustomImageDataUrl(value) {
  if (!value || value.length > MAX_CUSTOM_ITEM_DATA_URL_LENGTH) return false;
  return /^data:image\/(?:png|jpe?g|webp|svg\+xml);/i.test(value) || /^data:image\/svg\+xml,/i.test(value);
}

function nextLaneOrder(room, laneId) {
  const laneItems = room.items.filter((entry) => entry.laneId === laneId);
  if (!laneItems.length) return 0;
  return Math.max(...laneItems.map((entry) => entry.order)) + 1;
}

function reindexLane(room, laneId, sortedItems) {
  const laneItems =
    sortedItems ||
    room.items.filter((entry) => entry.laneId === laneId).sort((a, b) => a.order - b.order);
  laneItems.forEach((entry, index) => {
    entry.order = index;
  });
}

async function importTierMakerTemplate(sourceUrl) {
  const directHtml = await fetchTierMakerHtml(sourceUrl).catch(() => "");
  if (directHtml && !isBlockedHtml(directHtml)) {
    const template = parseTierMakerHtml(directHtml, sourceUrl);
    if (template.items.length) return template;
  }

  const markdown = await fetchReaderMarkdown(sourceUrl);
  const template = parseReaderMarkdown(markdown, sourceUrl);
  if (!template.items.length) {
    throw new Error("이미지 목록을 찾지 못했습니다. 다른 TierMaker 링크로 다시 시도해주세요.");
  }
  return template;
}

function buildTemplateFromSnapshot(payload) {
  const sourceUrl = normalizeTierMakerUrl(payload?.sourceUrl);
  const title = cleanTitle(String(payload?.title || "").slice(0, MAX_SNAPSHOT_TITLE_LENGTH)) || "TierMaker Room";
  const imageUrls = sanitizeSnapshotImageUrls(payload?.imageUrls, sourceUrl);
  const rowTexts = sanitizeSnapshotRows(payload?.rowTexts);

  if (!imageUrls.length) {
    throw new Error("원본 페이지에서 템플릿 이미지를 찾지 못했습니다.");
  }

  return buildTemplate({
    title,
    sourceUrl,
    rowTexts,
    imageUrls,
    importedVia: "browser-snapshot",
  });
}

function sanitizeSnapshotImageUrls(value, sourceUrl) {
  if (!Array.isArray(value)) return [];
  return unique(
    value
      .map((url) => resolveUrl(String(url || "").trim(), sourceUrl))
      .filter(isTemplateImageUrl)
  ).slice(0, MAX_SNAPSHOT_ITEMS);
}

function sanitizeSnapshotRows(value) {
  if (!Array.isArray(value)) return [];
  return unique(
    value
      .map((label) =>
        String(label || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, MAX_CUSTOM_TIER_LABEL_LENGTH)
      )
      .filter(Boolean)
      .filter((label) => !/choose a label|delete row|add a row|edit label/i.test(label))
  ).slice(0, MAX_SNAPSHOT_TIERS);
}

async function searchTierMakerTemplates(query, category = "") {
  const sources = [];
  if (category) {
    sources.push(fetchReaderMarkdown(`https://tiermaker.com/categories/${category}`));
  }

  if (query) {
    const ddgUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(`site:tiermaker.com/create/ ${query}`)}`;
    sources.push(fetchReaderMarkdown(ddgUrl));
    const categorySlug = slugifyCategory(query);
    if (categorySlug && categorySlug !== category) {
      sources.push(fetchReaderMarkdown(`https://tiermaker.com/categories/${categorySlug}`));
    }
  } else if (!category) {
    sources.push(fetchReaderMarkdown("https://tiermaker.com/"));
  }

  const markdowns = await Promise.allSettled(sources);
  const templates = [];
  for (const result of markdowns) {
    if (result.status === "fulfilled") {
      templates.push(...parseTemplateSearchMarkdown(result.value, query));
    }
  }

  return uniqueTemplates(templates).slice(0, 18);
}

function normalizeSearchCategory(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function parseTemplateSearchMarkdown(markdown, query) {
  const links = Array.from(markdown.matchAll(/\[([^\]]+)]\((https?:\/\/[^)]+)\)/g));
  const normalizedQuery = normalizeSearchText(query);
  return links
    .map((match) => {
      const url = normalizeTemplateSearchUrl(match[2]);
      if (!url) return null;
      const title = cleanSearchTitle(match[1]);
      return {
        title,
        url,
        sourceKey: createSourceKey(url),
      };
    })
    .filter(Boolean)
    .filter((template) => {
      if (!normalizedQuery) return true;
      const haystack = normalizeSearchText(`${template.title} ${template.url}`);
      return normalizedQuery
        .split(/\s+/)
        .filter(Boolean)
        .some((word) => haystack.includes(word));
    });
}

function normalizeTemplateSearchUrl(rawUrl) {
  try {
    let url = new URL(rawUrl);
    if (url.hostname.includes("duckduckgo.com") && url.pathname === "/l/") {
      const nestedUrl = url.searchParams.get("uddg");
      if (!nestedUrl) return "";
      url = new URL(nestedUrl);
    }

    if (!/(^|\.)tiermaker\.com$/i.test(url.hostname) || !url.pathname.startsWith("/create/")) {
      return "";
    }

    url.hash = "";
    url.searchParams.delete("presentationMode");
    return url.toString();
  } catch (_error) {
    return "";
  }
}

function uniqueTemplates(templates) {
  const seen = new Set();
  const result = [];
  for (const template of templates) {
    if (seen.has(template.sourceKey)) continue;
    seen.add(template.sourceKey);
    result.push({
      title: template.title,
      url: template.url,
    });
  }
  return result;
}

function cleanSearchTitle(value) {
  return String(value || "TierMaker Template")
    .replace(/^Create\s+(a|an)\s+/i, "")
    .replace(/\s+-\s+TierMaker$/i, "")
    .replace(/\s+Tier List Maker$/i, "")
    .replace(/\s+Tier List$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugifyCategory(value) {
  return normalizeSearchText(value)
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function fetchTierMakerHtml(sourceUrl) {
  const response = await fetch(sourceUrl, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });
  if (!response.ok) throw new Error(`TierMaker returned ${response.status}`);
  return response.text();
}

async function fetchReaderMarkdown(sourceUrl) {
  const readerUrl = `https://r.jina.ai/${sourceUrl}`;
  const response = await fetch(readerUrl, {
    headers: {
      accept: "text/plain,text/markdown,*/*",
      "user-agent": "MultiplayTierMaker/1.0",
    },
  });
  if (!response.ok) {
    throw new Error("링크 내용을 읽지 못했습니다. 잠시 후 다시 시도해주세요.");
  }
  return response.text();
}

function parseTierMakerHtml(html, sourceUrl) {
  const $ = cheerio.load(html);
  const title = cleanTitle(
    $("h1").first().text().trim() || $("title").first().text().trim() || "TierMaker Room"
  );
  const imageUrls = unique(
    [
      ...$("img")
        .map((_index, image) => {
          const element = $(image);
          return [
            element.attr("data-src"),
            element.attr("data-original"),
            element.attr("data-lazy-src"),
            element.attr("data-url"),
            element.attr("src"),
            ...splitSrcset(element.attr("srcset")),
          ];
        })
        .get()
        .flat(),
      ...extractTemplateImageUrlsFromText(html),
    ]
      .map((url) => normalizeTemplateImageUrl(url, sourceUrl))
      .filter(isTemplateImageUrl)
  );

  const rowTexts = unique(
    $(".tier-label, .label-holder, .tier-list-row .label, .tier .label")
      .map((_index, element) => $(element).text().trim())
      .get()
      .filter(Boolean)
  );

  return buildTemplate({
    title,
    sourceUrl,
    rowTexts,
    imageUrls,
    importedVia: "tiermaker-html",
  });
}

function extractTemplateImageUrlsFromText(value) {
  return Array.from(
    String(value || "").matchAll(
      /(?:https?:\/\/(?:www\.)?tiermaker\.com)?\/images\/+(?:media\/)?template_images\/[^"'`\s<>&)]+/gi
    )
  ).map((match) => cleanExtractedImageUrl(match[0]));
}

function splitSrcset(value) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function parseReaderMarkdown(markdown, sourceUrl) {
  const lines = markdown.split(/\r?\n/).map((line) => line.trim());
  const titleLine =
    lines.find((line) => line.startsWith("# ")) ||
    lines.find((line) => line.startsWith("Title:")) ||
    "";
  const title = cleanTitle(titleLine.replace(/^#\s*/, "").replace(/^Title:\s*/i, ""));
  const imageUrls = unique(
    [
      ...Array.from(markdown.matchAll(/!\[[^\]]*]\((https?:\/\/[^)]+)\)/g)).map((match) => match[1]),
      ...extractTemplateImageUrlsFromText(markdown),
    ]
      .map((url) => normalizeTemplateImageUrl(url, sourceUrl))
      .filter(isTemplateImageUrl)
  );

  const rowTexts = extractRowsFromMarkdown(lines);
  return buildTemplate({
    title: title || "TierMaker Room",
    sourceUrl,
    rowTexts,
    imageUrls,
    importedVia: "reader-markdown",
  });
}

function extractRowsFromMarkdown(lines) {
  const cleaned = lines.map(stripMarkdownLine).filter(Boolean);
  const shareIndex = cleaned.findIndex((line) => /Share on Twitter|Share on FB/i.test(line));
  const start = shareIndex >= 0 ? shareIndex + 1 : 0;
  const rows = [];

  for (let index = start; index < cleaned.length; index += 1) {
    const line = cleaned[index];
    const originalLine = lines[index] || "";
    if (/^!\[/.test(originalLine) || /^!?Image\s+\d+/i.test(line) || /Pin Images|Choose a Label|Edit Label|Delete Row|Add a Row|Log in|Download Image|Presentation Mode|View the Community/i.test(line)) {
      if (rows.length) break;
      continue;
    }
    if (line.length > 90) continue;
    if (/https?:\/\//i.test(line)) continue;
    if (/Create a|This template has|Check out|Spin Random|Live Voting|Alignment Chart/i.test(line)) continue;
    if (/^\*|\[|]|\(|\)|^#+/.test(line)) continue;
    rows.push(line);
  }

  return unique(rows).slice(0, 12);
}

function buildTemplate({ title, sourceUrl, rowTexts, imageUrls, importedVia }) {
  const sourceKey = createSourceKey(sourceUrl);
  const tiers = (rowTexts.length ? rowTexts : ["S", "A", "B", "C", "D"]).map((label, index) => ({
    id: `tier-${index + 1}`,
    label,
    color: TIER_COLORS[index % TIER_COLORS.length],
  }));

  return {
    title,
    sourceUrl,
    sourceKey,
    importedVia,
    tiers,
    items: imageUrls.map((src, index) => ({
      id: `item-${hashId(src)}-${index}`,
      src,
      alt: `이미지 ${index + 1}`,
    })),
  };
}

function normalizeTierMakerUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("TierMaker 링크를 입력해주세요.");

  const repaired = raw
    .replace(/\s+/g, "")
    .replace(/(presentationMode=false)w\/?$/i, "$1")
    .replace(/\/+$/g, "");
  const withProtocol = /^https?:\/\//i.test(repaired) ? repaired : `https://${repaired}`;
  const url = new URL(withProtocol);

  if (!/(^|\.)tiermaker\.com$/i.test(url.hostname) || !url.pathname.startsWith("/create/")) {
    throw new Error("tiermaker.com/create/... 형식의 링크만 지원합니다.");
  }

  return url.toString();
}

function createSourceKey(sourceUrl) {
  if (!sourceUrl) return sourceUrl;
  try {
    const url = new URL(sourceUrl);
    url.hash = "";
    url.searchParams.delete("presentationMode");
    url.searchParams.sort();
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch (_error) {
    return sourceUrl;
  }
}

function getPublicBaseUrl() {
  const envUrl = String(process.env.PUBLIC_BASE_URL || "").trim();
  if (envUrl) return envUrl.replace(/\/+$/, "");

  const filePath = path.join(__dirname, ".omx", "public-base-url.txt");
  try {
    return fs.readFileSync(filePath, "utf8").trim().replace(/\/+$/, "");
  } catch (_error) {
    return "";
  }
}

function sanitizeNickname(value) {
  const nickname = String(value || "").trim().slice(0, 18);
  return nickname || "익명";
}

function stripMarkdownLine(line) {
  return line
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[*_`>#-]/g, "")
    .trim();
}

function cleanTitle(value) {
  return String(value || "TierMaker Room")
    .replace(/\s+-\s+TierMaker$/i, "")
    .replace(/^Create\s+(a|an)\s+/i, "")
    .replace(/\s+Tier List Maker$/i, "")
    .replace(/\s+Tier List$/i, "")
    .trim();
}

function isBlockedHtml(html) {
  return /Just a moment|challenge-platform|cdn-cgi\/challenge/i.test(html);
}

function isTemplateImageUrl(url) {
  return /https?:\/\/(?:www\.)?tiermaker\.com\/images\/+(?:media\/)?template_images\//i.test(url);
}

function normalizeTemplateImageUrl(value, baseUrl = "https://tiermaker.com") {
  const url = resolveUrl(cleanExtractedImageUrl(value), baseUrl);
  return isTemplateImageUrl(url) ? url : "";
}

function cleanExtractedImageUrl(value) {
  return String(value || "")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .replace(/[)\].,;]+$/g, "")
    .trim();
}

function sendCachedImage(res, cached) {
  res.setHeader("content-type", cached.contentType);
  res.setHeader("cache-control", "public, max-age=3600");
  res.send(cached.buffer);
}

function resolveUrl(url, baseUrl) {
  if (!url) return "";
  try {
    return new URL(url, baseUrl).toString();
  } catch (_error) {
    return "";
  }
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function hashId(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 10);
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}
