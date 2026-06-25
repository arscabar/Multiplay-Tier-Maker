const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
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
const IMAGE_SEARCH_TIMEOUT_MS = 10_000;
const IMAGE_SEARCH_CACHE_TTL_MS = 1000 * 60 * 60 * 6;
const MAX_PROXY_IMAGE_BYTES = 6_000_000;
const PIKU_IMAGE_ENRICH_CONCURRENCY = 3;
const PIKU_IMAGE_CANDIDATE_LIMIT = 14;
const WORLDCUP_BRACKET_SIZES = [4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];
const MAX_WORLDCUP_BRACKET_SIZE = MAX_SNAPSHOT_ITEMS;
const PIKU_CURL_TIMEOUT_SECONDS = 25;
const PIKU_CRAWL_EXTRA_MATCH_LIMIT = 24;
const PIKU_CRAWL_DELAY_MS = 500;
const PIKU_CRAWL_BLOCK_RETRY_DELAY_MS = 2500;
const PIKU_CRAWL_MAX_BLOCK_RETRIES = 5;
const ITEM_LOCK_TTL_MS = 30_000;
const WORLDCUP_TIE_BREAK_MS = 5500;
const PIKU_TEMPLATE_CACHE_TTL_MS = 1000 * 60 * 10;
const PIKU_SEARCH_CACHE_TTL_MS = 1000 * 60 * 5;
const ROOM_MODE_TIERMAKER = "tiermaker";
const ROOM_MODE_WORLDCUP = "worldcup";

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const rooms = new Map();
const socketRooms = new Map();
const imageCache = new Map();
const imageSearchCache = new Map();
const worldcupTieTimers = new Map();
const pikuTemplateCache = new Map();
const pikuSearchCache = new Map();

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
  "/vendor/lucide",
  express.static(path.join(__dirname, "node_modules", "lucide", "dist", "umd"), {
    etag: false,
    maxAge: 0,
    setHeaders: (res) => {
      res.setHeader("cache-control", "no-store");
    },
  })
);
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
    const mode = normalizeRoomMode(req.query.mode);
    const templates = await searchTemplatesByMode(mode, query, category);
    res.json({ templates });
  } catch (error) {
    res.status(502).json({
      message: error.message || "템플릿을 찾지 못했습니다.",
    });
  }
});

app.get("/api/templates/preview", async (req, res) => {
  try {
    const mode = normalizeRoomMode(req.query.mode);
    const sourceUrl = normalizeSourceUrlForMode(mode, req.query?.url);
    const options = { ...getTemplateOptionsFromRequest(mode, req.query), previewOnly: true };
    const template = await importTemplateByMode(mode, sourceUrl, options);
    res.json({ template: serializeTemplatePreview(template) });
  } catch (error) {
    res.status(422).json({
      message: error.message || "템플릿 미리보기를 불러오지 못했습니다.",
    });
  }
});

app.post("/api/rooms", async (req, res) => {
  try {
    const mode = normalizeRoomMode(req.body?.mode);
    const sourceUrl = normalizeSourceUrlForMode(mode, req.body?.url);
    const options = getTemplateOptionsFromRequest(mode, req.body);
    const sourceKey = createSourceKey(sourceUrl, mode, options);
    const existingRoom = mode === ROOM_MODE_WORLDCUP ? null : findRoomBySourceKey(sourceKey);
    if (existingRoom) {
      existingRoom.updatedAt = Date.now();
      io.emit("rooms:update", serializeRooms());
      res.status(200).json({ existing: true, room: serializeRoomSummary(existingRoom) });
      return;
    }

    const template = await importTemplateByMode(mode, sourceUrl, options);
    const effectiveSourceKey = mode === ROOM_MODE_WORLDCUP ? template.sourceKey || sourceKey : sourceKey;
    const importedExistingRoom = findRoomBySourceKey(effectiveSourceKey);
    if (importedExistingRoom) {
      importedExistingRoom.updatedAt = Date.now();
      io.emit("rooms:update", serializeRooms());
      res.status(200).json({ existing: true, room: serializeRoomSummary(importedExistingRoom) });
      return;
    }

    template.sourceKey = effectiveSourceKey;
    const room = createRoom(template);
    io.emit("rooms:update", serializeRooms());
    res.status(201).json({ existing: false, room: serializeRoomSummary(room), hostToken: room.hostToken });
  } catch (error) {
    res.status(422).json({
      message: error.message || "링크를 가져오지 못했습니다.",
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
    res.status(201).json({ existing: false, room: serializeRoomSummary(room), hostToken: room.hostToken });
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
    res.status(201).json({ existing: false, room: serializeRoomSummary(room), hostToken: room.hostToken });
  } catch (error) {
    res.status(422).json({
      message: error.message || "페이지 HTML에서 템플릿을 가져오지 못했습니다.",
    });
  }
});

app.delete("/api/rooms/:roomId", async (req, res) => {
  const roomId = String(req.params.roomId || "");
  const room = rooms.get(roomId);
  if (!room) {
    res.status(404).json({ message: "방을 찾을 수 없습니다." });
    return;
  }

  if (!hasHostToken(room, getRequestHostToken(req))) {
    res.status(403).json({ message: "방장만 방을 삭제할 수 있습니다." });
    return;
  }

  const deleted = await deleteRoom(roomId);
  if (!deleted) {
    res.status(404).json({ message: "방을 찾을 수 없습니다." });
    return;
  }

  res.json({ ok: true });
});

app.get("/api/image", async (req, res) => {
  try {
    const rawUrl = String(req.query.url || "");
    const imageUrl = normalizeSupportedImageUrl(rawUrl);
    if (!imageUrl) {
      res.status(400).send("Only supported template images can be proxied.");
      return;
    }

    sendCachedImage(res, await fetchAndCacheImage(imageUrl));
  } catch (error) {
    if (error?.name === "AbortError") {
      res.status(504).send("Image fetch timed out.");
      return;
    }
    res.status(error.statusCode || 400).send(error.message || "Invalid image URL.");
  }
});

io.on("connection", (socket) => {
  socket.emit("rooms:update", serializeRooms());

  socket.on("room:join", ({ roomId, nickname, hostToken }) => {
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
      isHost: hasHostToken(room, hostToken),
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

  socket.on("room:delete", async ({ roomId }, reply) => {
    const respond = typeof reply === "function" ? reply : () => {};
    const targetRoomId = String(roomId || socketRooms.get(socket.id) || "");
    const room = rooms.get(targetRoomId);
    if (!room) {
      respond({ ok: false, message: "방을 찾을 수 없습니다." });
      return;
    }
    if (!isSocketHost(room, socket)) {
      respond({ ok: false, message: "방장만 방을 삭제할 수 있습니다." });
      return;
    }
    await deleteRoom(targetRoomId);
    respond({ ok: true });
  });

  socket.on("item:move", ({ itemId, laneId, beforeId }, reply) => {
    const respond = typeof reply === "function" ? reply : () => {};
    const room = getSocketRoom(socket);
    if (!room) {
      respond({ ok: false, message: "방에 먼저 입장해주세요." });
      return;
    }
    if (!isTierMakerRoom(room)) {
      respond({ ok: false, message: "티어메이커 방에서만 이미지를 이동할 수 있습니다." });
      return;
    }
    const pruned = pruneExpiredActiveItems(room);
    const normalizedItemId = String(itemId || "");
    const lockOwner = getItemLockOwner(room, normalizedItemId, socket.id);
    if (lockOwner) {
      socket.emit("item:blocked", {
        itemId: normalizedItemId,
        nickname: lockOwner.nickname,
      });
      respond({ ok: false, message: `${lockOwner.nickname}님이 잡고 있는 이미지입니다.` });
      return;
    }

    const changed = moveItem(room, normalizedItemId, String(laneId || ""), beforeId);
    if (changed) {
      io.to(room.id).emit("room:state", serializeRoom(room));
      io.emit("rooms:update", serializeRooms());
      respond({ ok: true, changed: true });
    } else {
      if (pruned) {
        io.to(room.id).emit("item:focus", {
          activeItems: Object.values(room.activeItems),
        });
      }
      respond({ ok: false, message: "이미지를 이동할 수 없습니다." });
    }
  });

  socket.on("item:add", ({ src, alt }, reply) => {
    const room = getSocketRoom(socket);
    const respond = typeof reply === "function" ? reply : () => {};
    if (!room) {
      respond({ ok: false, message: "방에 먼저 입장해주세요." });
      return;
    }
    if (!isTierMakerRoom(room)) {
      respond({ ok: false, message: "티어메이커 방에서만 이미지를 추가할 수 있습니다." });
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
    if (!isTierMakerRoom(room)) {
      respond({ ok: false, message: "티어메이커 방에서만 티어를 추가할 수 있습니다." });
      return;
    }
    if (!isSocketHost(room, socket)) {
      respond({ ok: false, message: "방장만 티어를 추가할 수 있습니다." });
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

  socket.on("tier:move", ({ tierId, beforeId }, reply) => {
    const respond = typeof reply === "function" ? reply : () => {};
    const room = getSocketRoom(socket);
    if (!room) {
      respond({ ok: false, message: "방에 먼저 입장해주세요." });
      return;
    }
    if (!isTierMakerRoom(room)) {
      respond({ ok: false, message: "티어메이커 방에서만 티어 순서를 바꿀 수 있습니다." });
      return;
    }
    if (!isSocketHost(room, socket)) {
      respond({ ok: false, message: "방장만 티어 순서를 바꿀 수 있습니다." });
      return;
    }
    const changed = moveTier(room, String(tierId || ""), beforeId ? String(beforeId) : null);
    if (changed) {
      room.updatedAt = Date.now();
      io.to(room.id).emit("room:state", serializeRoom(room));
      io.emit("rooms:update", serializeRooms());
    }
    respond({ ok: true, changed });
  });

  socket.on("item:focus", ({ itemId }) => {
    const room = getSocketRoom(socket);
    if (!room || !room.players[socket.id]) return;
    if (!isTierMakerRoom(room)) return;

    if (!room.activeItems) room.activeItems = {};
    pruneExpiredActiveItems(room);
    const normalizedItemId = String(itemId || "");
    const itemExists = room.items.some((item) => item.id === normalizedItemId);

    if (!itemExists) {
      delete room.activeItems[socket.id];
    } else {
      const lockOwner = getItemLockOwner(room, normalizedItemId, socket.id);
      if (lockOwner) {
        socket.emit("item:blocked", {
          itemId: normalizedItemId,
          nickname: lockOwner.nickname,
        });
        io.to(room.id).emit("item:focus", {
          activeItems: Object.values(room.activeItems),
        });
        return;
      }

      const player = room.players[socket.id];
      room.activeItems[socket.id] = {
        itemId: normalizedItemId,
        playerId: socket.id,
        nickname: player.nickname,
        color: player.color,
        lockedAt: Date.now(),
      };
    }

    io.to(room.id).emit("item:focus", {
      activeItems: Object.values(room.activeItems),
    });
  });

  socket.on("room:reset", (_payload, reply) => {
    const respond = typeof reply === "function" ? reply : () => {};
    const room = getSocketRoom(socket);
    if (!room) {
      respond({ ok: false, message: "방에 먼저 입장해주세요." });
      return;
    }
    if (!isSocketHost(room, socket)) {
      respond({ ok: false, message: "방장만 방을 초기화할 수 있습니다." });
      return;
    }
    resetRoomState(room);
    room.updatedAt = Date.now();
    io.to(room.id).emit("room:state", serializeRoom(room));
    respond({ ok: true });
  });

  socket.on("worldcup:vote", ({ itemId }, reply) => {
    const respond = typeof reply === "function" ? reply : () => {};
    const room = getSocketRoom(socket);
    if (!room || !room.players[socket.id]) {
      respond({ ok: false, message: "방에 먼저 입장해주세요." });
      return;
    }
    if (!isWorldcupRoom(room)) {
      respond({ ok: false, message: "이상형월드컵 방이 아닙니다." });
      return;
    }

    const result = voteWorldcup(room, socket.id, String(itemId || ""));
    if (!result.ok) {
      respond(result);
      return;
    }

    io.to(room.id).emit("room:state", serializeRoom(room));
    io.emit("rooms:update", serializeRooms());
    respond(result);
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
    mode: template.mode || ROOM_MODE_TIERMAKER,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hostToken: crypto.randomBytes(18).toString("hex"),
    playerColorIndex: 0,
    players: {},
    activeItems: {},
    items: template.items.map((item, index) => ({
      ...item,
      laneId: "pool",
      order: index,
    })),
  };

  if (room.mode === ROOM_MODE_WORLDCUP) {
    room.worldcup = createWorldcupState(room.items.map((item) => item.id));
    prepareWorldcupMatch(room);
  }

  rooms.set(id, room);
  return room;
}

async function deleteRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return false;

  clearWorldcupTieTimer(roomId);
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
    const roomSourceKey = room.template.sourceKey || createSourceKey(room.template.sourceUrl || "", getRoomMode(room));
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
  const mode = getRoomMode(room);
  return {
    id: room.id,
    mode,
    title: room.template.title,
    imageCount: room.items.length,
    bracketSize: isWorldcupRoom(room) ? room.template.bracketSize || room.items.length : 0,
    tierCount: isTierMakerRoom(room) ? room.template.tiers.length : 0,
    playerCount: Object.keys(room.players).length,
    players: serializePlayers(room),
    sourceUrl: room.template.sourceUrl,
    updatedAt: room.updatedAt,
  };
}

function serializeRoom(room) {
  pruneExpiredActiveItems(room);
  return {
    ...serializeRoomSummary(room),
    tiers: isTierMakerRoom(room) ? room.template.tiers : [],
    activeItems: isTierMakerRoom(room) ? Object.values(room.activeItems || {}) : [],
    items: room.items
      .slice()
      .sort((a, b) => a.laneId.localeCompare(b.laneId) || a.order - b.order),
    worldcup: isWorldcupRoom(room) ? serializeWorldcup(room) : null,
    players: serializePlayers(room),
  };
}

function serializePlayers(room) {
  return Object.values(room.players).map((player) => ({
    id: player.id,
    nickname: player.nickname,
    color: player.color,
    isHost: Boolean(player.isHost),
  }));
}

function serializeTemplatePreview(template) {
  const mode = template.mode || ROOM_MODE_TIERMAKER;
  const totalCandidateCount =
    mode === ROOM_MODE_WORLDCUP ? Number(template.totalCandidateCount || template.imageCount || template.items.length || 0) : template.items.length;
  return {
    mode,
    title: template.title,
    sourceUrl: template.sourceUrl,
    imageCount: mode === ROOM_MODE_WORLDCUP ? totalCandidateCount : template.items.length,
    availableItemCount: mode === ROOM_MODE_WORLDCUP ? Number(template.availableItemCount || template.items.length || 0) : template.items.length,
    previewItemCount: template.items.length,
    bracketSize: mode === ROOM_MODE_WORLDCUP ? template.bracketSize || template.items.length : 0,
    requestedBracketSize: template.requestedBracketSize || 0,
    bracketOptions: template.bracketOptions || [],
    tierCount: mode === ROOM_MODE_WORLDCUP ? 0 : template.tiers.length,
    tiers: (mode === ROOM_MODE_WORLDCUP ? [] : template.tiers).slice(0, 10).map((tier) => ({
      label: tier.label,
      color: tier.color,
    })),
    items: template.items.slice(0, 12).map((item) => ({
      src: item.src,
      alt: item.alt,
      placeholderSrc: item.placeholderSrc || "",
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

function getItemLockOwner(room, itemId, currentPlayerId) {
  pruneExpiredActiveItems(room);
  if (!itemId || !room.activeItems) return null;
  return (
    Object.values(room.activeItems).find(
      (active) => active.itemId === itemId && active.playerId !== currentPlayerId
    ) || null
  );
}

function pruneExpiredActiveItems(room) {
  if (!room?.activeItems) return false;
  const now = Date.now();
  let changed = false;
  for (const [playerId, active] of Object.entries(room.activeItems)) {
    const lockedAt = Number(active.lockedAt || 0);
    if (!lockedAt || now - lockedAt > ITEM_LOCK_TTL_MS) {
      delete room.activeItems[playerId];
      changed = true;
    }
  }
  return changed;
}

function isSocketHost(room, socket) {
  return Boolean(room?.players?.[socket.id]?.isHost);
}

function getRequestHostToken(req) {
  return String(req.headers["x-host-token"] || req.query?.hostToken || "");
}

function hasHostToken(room, token) {
  const supplied = String(token || "");
  if (!room?.hostToken || !supplied) return false;
  const expected = String(room.hostToken);
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return suppliedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
}

function getRoomMode(room) {
  return room?.mode || room?.template?.mode || ROOM_MODE_TIERMAKER;
}

function isTierMakerRoom(room) {
  return getRoomMode(room) === ROOM_MODE_TIERMAKER;
}

function isWorldcupRoom(room) {
  return getRoomMode(room) === ROOM_MODE_WORLDCUP;
}

function resetRoomState(room) {
  room.activeItems = {};
  clearWorldcupTieTimer(room.id);
  if (isWorldcupRoom(room)) {
    room.worldcup = createWorldcupState(room.items.map((item) => item.id));
    prepareWorldcupMatch(room);
    return;
  }

  room.items.forEach((item, index) => {
    item.laneId = "pool";
    item.order = index;
  });
}

function createWorldcupState(itemIds) {
  return {
    round: 1,
    match: 0,
    queue: shuffleValues(itemIds),
    nextQueue: [],
    currentPair: [],
    votes: {},
    tieBreak: null,
    history: [],
    championId: null,
    completed: false,
  };
}

function prepareWorldcupMatch(room) {
  if (!isWorldcupRoom(room)) return;
  const state = room.worldcup || createWorldcupState(room.items.map((item) => item.id));
  room.worldcup = state;

  if (state.tieBreak) return;
  if (state.completed || state.currentPair.length === 2) return;

  while (!state.completed && state.currentPair.length < 2) {
    if (state.queue.length >= 2) {
      state.currentPair = [state.queue.shift(), state.queue.shift()];
      state.votes = {};
      state.tieBreak = null;
      state.match += 1;
      return;
    }

    if (state.queue.length === 1) {
      state.nextQueue.push(state.queue.shift());
    }

    if (state.nextQueue.length <= 1) {
      state.championId = state.nextQueue[0] || state.currentPair[0] || null;
      state.completed = Boolean(state.championId);
      state.currentPair = [];
      state.votes = {};
      state.tieBreak = null;
      return;
    }

    state.round += 1;
    state.match = 0;
    state.queue = shuffleValues(state.nextQueue);
    state.nextQueue = [];
  }
}

function voteWorldcup(room, playerId, itemId) {
  prepareWorldcupMatch(room);
  const state = room.worldcup;
  if (!state || state.completed) {
    return { ok: false, message: "이미 월드컵이 끝났습니다." };
  }
  if (state.tieBreak) {
    return { ok: false, message: "동률 판정이 진행 중입니다." };
  }
  if (!state.currentPair.includes(itemId)) {
    return { ok: false, message: "현재 대결 후보만 선택할 수 있습니다." };
  }

  state.votes[playerId] = itemId;
  const resolution = getWorldcupResolutionIfReady(room);
  if (!resolution.winnerId && !resolution.tie) {
    room.updatedAt = Date.now();
    return { ok: true, advanced: false };
  }

  if (resolution.tie) {
    startWorldcupTieBreak(room, resolution.candidateIds);
    return { ok: true, advanced: false, tieBreak: true };
  }

  advanceWorldcup(room, resolution.winnerId);
  return { ok: true, advanced: true, winnerId: resolution.winnerId };
}

function getWorldcupResolutionIfReady(room) {
  const state = room.worldcup;
  const players = Object.keys(room.players);
  const playerCount = Math.max(players.length, 1);
  const currentVotes = Object.entries(state.votes).filter(
    ([playerId, votedItemId]) => players.includes(playerId) && state.currentPair.includes(votedItemId)
  );
  const counts = countVotes(currentVotes.map(([, votedItemId]) => votedItemId));
  const majority = Math.floor(playerCount / 2) + 1;
  const majorityWinner = state.currentPair.find((candidateId) => (counts[candidateId] || 0) >= majority);
  if (majorityWinner) return { winnerId: majorityWinner, tie: false };

  if (currentVotes.length < playerCount) return { winnerId: "", tie: false };

  const highestVoteCount = Math.max(...state.currentPair.map((candidateId) => counts[candidateId] || 0));
  const candidateIds = state.currentPair.filter((candidateId) => (counts[candidateId] || 0) === highestVoteCount);
  if (candidateIds.length > 1) {
    return { winnerId: "", tie: true, candidateIds };
  }
  return { winnerId: candidateIds[0] || state.currentPair[0], tie: false };
}

function startWorldcupTieBreak(room, candidateIds) {
  const state = room.worldcup;
  if (!state || state.tieBreak) return;
  const candidates = candidateIds.length ? candidateIds : state.currentPair.slice();
  const winnerId = candidates[crypto.randomInt(candidates.length)];
  const now = Date.now();
  state.tieBreak = {
    candidateIds: candidates,
    winnerId,
    startedAt: now,
    resolvesAt: now + WORLDCUP_TIE_BREAK_MS,
  };
  room.updatedAt = now;
  scheduleWorldcupTieBreak(room.id);
}

function scheduleWorldcupTieBreak(roomId) {
  clearWorldcupTieTimer(roomId);
  const timer = setTimeout(() => {
    worldcupTieTimers.delete(roomId);
    const room = rooms.get(roomId);
    if (!room || !isWorldcupRoom(room) || !room.worldcup?.tieBreak) return;
    const winnerId = room.worldcup.tieBreak.winnerId;
    advanceWorldcup(room, winnerId);
    io.to(room.id).emit("room:state", serializeRoom(room));
    io.emit("rooms:update", serializeRooms());
  }, WORLDCUP_TIE_BREAK_MS);
  worldcupTieTimers.set(roomId, timer);
}

function clearWorldcupTieTimer(roomId) {
  const timer = worldcupTieTimers.get(roomId);
  if (!timer) return;
  clearTimeout(timer);
  worldcupTieTimers.delete(roomId);
}

function advanceWorldcup(room, winnerId) {
  const state = room.worldcup;
  const tieBreak = state.tieBreak;
  state.history.push({
    round: state.round,
    match: state.match,
    pair: state.currentPair.slice(),
    winnerId,
    resolvedBy: tieBreak ? "random" : "vote",
    at: Date.now(),
  });
  state.nextQueue.push(winnerId);
  state.currentPair = [];
  state.votes = {};
  state.tieBreak = null;
  prepareWorldcupMatch(room);
  room.updatedAt = Date.now();
}

function serializeWorldcup(room) {
  prepareWorldcupMatch(room);
  const state = room.worldcup;
  const votes = Object.entries(state.votes || {})
    .filter(([playerId, itemId]) => room.players[playerId] && state.currentPair.includes(itemId))
    .map(([playerId, itemId]) => ({
      playerId,
      itemId,
      nickname: room.players[playerId].nickname,
      color: room.players[playerId].color,
    }));

  return {
    round: state.round,
    match: state.match,
    bracketSize: room.template.bracketSize || room.items.length,
    totalCandidates: room.items.length,
    currentPair: state.currentPair,
    votes,
    voteCounts: countVotes(votes.map((vote) => vote.itemId)),
    tieBreak: serializeWorldcupTieBreak(state),
    playerCount: Object.keys(room.players).length,
    remainingInRound: state.queue.length + state.currentPair.length,
    nextRoundCount: state.nextQueue.length,
    completed: state.completed,
    championId: state.championId,
    history: state.history.slice(-12),
  };
}

function serializeWorldcupTieBreak(state) {
  if (!state?.tieBreak) return null;
  return {
    candidateIds: state.tieBreak.candidateIds,
    winnerId: state.tieBreak.winnerId,
    startedAt: state.tieBreak.startedAt,
    resolvesAt: state.tieBreak.resolvesAt,
    durationMs: Math.max(1, state.tieBreak.resolvesAt - state.tieBreak.startedAt),
  };
}

function countVotes(values) {
  return values.reduce((acc, value) => {
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function shuffleValues(values) {
  const result = values.slice();
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
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

function normalizeRoomMode(value) {
  return String(value || ROOM_MODE_TIERMAKER).toLowerCase() === ROOM_MODE_WORLDCUP
    ? ROOM_MODE_WORLDCUP
    : ROOM_MODE_TIERMAKER;
}

function getTemplateOptionsFromRequest(mode, payload = {}) {
  if (normalizeRoomMode(mode) !== ROOM_MODE_WORLDCUP) return {};
  return {
    bracketSize: normalizeWorldcupBracketSize(payload?.bracketSize),
  };
}

function normalizeWorldcupBracketSize(value) {
  const size = Number(value || 0);
  return Number.isInteger(size) && size >= 2 && size <= MAX_WORLDCUP_BRACKET_SIZE ? size : 0;
}

function getEffectiveWorldcupBracketSize(requestedSize, itemCount, optionSizes = []) {
  const count = Number(itemCount || 0);
  if (count <= 2) return count;
  const available = (optionSizes.length ? optionSizes : WORLDCUP_BRACKET_SIZES)
    .filter((size) => size <= count)
    .sort((a, b) => a - b);
  const maxAvailable = available.at(-1) || 2;
  if (requestedSize && requestedSize <= count) return requestedSize;
  return maxAvailable;
}

function getWorldcupBracketOptions(candidateCount, availableItemCount = candidateCount, optionSizes = []) {
  const count = Number(candidateCount || 0);
  const importableCount = Number(availableItemCount || 0);
  const sizes = uniqueNumbers(optionSizes.length ? optionSizes : WORLDCUP_BRACKET_SIZES)
    .filter((size) => !count || size <= count)
    .filter((size) => size <= MAX_WORLDCUP_BRACKET_SIZE)
    .sort((a, b) => a - b);
  return sizes.map((size) => ({
    size,
    enabled: !count || size <= count,
    importable: size <= importableCount,
  }));
}

function normalizeSourceUrlForMode(mode, input) {
  return normalizeRoomMode(mode) === ROOM_MODE_WORLDCUP ? normalizePikuWorldcupUrl(input) : normalizeTierMakerUrl(input);
}

async function importTemplateByMode(mode, sourceUrl, options = {}) {
  return normalizeRoomMode(mode) === ROOM_MODE_WORLDCUP
    ? importPikuWorldcupTemplate(sourceUrl, options)
    : importTierMakerTemplate(sourceUrl);
}

async function searchTemplatesByMode(mode, query, category = "") {
  return normalizeRoomMode(mode) === ROOM_MODE_WORLDCUP
    ? searchPikuWorldcups(query)
    : searchTierMakerTemplates(query, category);
}

async function importPikuWorldcupTemplate(sourceUrl, options = {}) {
  const canonicalUrl = normalizePikuWorldcupUrl(sourceUrl);
  const metadata = await fetchPikuWorldcupMetadata(canonicalUrl);

  if (options.previewOnly) {
    return applyWorldcupTemplateOptions(metadata, options);
  }

  const bracketSize = pickPikuBracketSize(options.bracketSize, metadata);
  const cachedTemplate = getCachedPikuTemplate(canonicalUrl, bracketSize);
  if (cachedTemplate) return applyWorldcupTemplateOptions(cachedTemplate, { ...options, bracketSize });

  let template = null;
  try {
    template = await importPikuRankDataTemplate(canonicalUrl, bracketSize, metadata);
  } catch (_error) {
    template = null;
  }
  if (!template || template.items.length < bracketSize) {
    template = await collectPikuWorldcupItems(canonicalUrl, bracketSize, metadata);
  }
  if (template.items.length < 2) {
    template = await importPikuRankFallbackTemplate(canonicalUrl, metadata);
  }

  if (template.items.length < 2) {
    throw new Error("PIKU 원본 대전 화면에서 후보 이미지를 찾지 못했습니다. 잠시 후 다시 시도해주세요.");
  }

  setCachedPikuTemplate(canonicalUrl, template, bracketSize);
  return applyWorldcupTemplateOptions(template, { ...options, bracketSize });
}

function applyWorldcupTemplateOptions(template, options = {}) {
  const requestedBracketSize = normalizeWorldcupBracketSize(options.bracketSize);
  const availableItemCount = options.previewOnly
    ? Number(template.availableItemCount || template.totalCandidateCount || template.items.length || 0)
    : Number(template.items.length || 0);
  const detectedCandidateCount = Number(template.totalCandidateCount || 0);
  const totalCandidateCount = options.previewOnly
    ? Math.max(detectedCandidateCount, availableItemCount)
    : Math.max(detectedCandidateCount, availableItemCount);
  const explicitOptionSizes = getTemplateBracketOptionSizes(template);
  const optionAvailableCount = options.previewOnly ? totalCandidateCount : availableItemCount;
  const preferredBracketSize =
    requestedBracketSize ||
    getLargestTemplateBracketSize(template, totalCandidateCount) ||
    normalizeWorldcupBracketSize(template.bracketSize || template.defaultBracketSize);
  const effectiveBracketSize = getEffectiveWorldcupBracketSize(
    preferredBracketSize,
    options.previewOnly ? totalCandidateCount : availableItemCount,
    explicitOptionSizes
  );
  const itemLimit = Math.min(effectiveBracketSize || availableItemCount, availableItemCount);
  return {
    ...template,
    sourceKey: createSourceKey(template.sourceUrl, ROOM_MODE_WORLDCUP, { bracketSize: effectiveBracketSize }),
    totalCandidateCount,
    availableItemCount,
    requestedBracketSize,
    bracketSize: effectiveBracketSize,
    bracketOptions: getWorldcupBracketOptions(totalCandidateCount, optionAvailableCount, explicitOptionSizes),
    items: template.items.slice(0, itemLimit),
  };
}

async function fetchPikuWorldcupMetadata(canonicalUrl) {
  try {
    const html = await fetchPikuTextWithCurl(canonicalUrl);
    const template = parsePikuStartHtml(html, canonicalUrl);
    if (template.totalCandidateCount || template.bracketOptions.length) {
      return template;
    }
  } catch (_error) {
    // Fall back to the indexed rank page below.
  }

  const id = getPikuWorldcupId(canonicalUrl);
  const rankUrl = `https://www.piku.co.kr/w/rank/${id}`;
  const markdown = await fetchReaderMarkdown(rankUrl);
  return parsePikuRankMarkdown(markdown, canonicalUrl);
}

async function importPikuRankFallbackTemplate(canonicalUrl, metadata) {
  const id = getPikuWorldcupId(canonicalUrl);
  const rankUrl = `https://www.piku.co.kr/w/rank/${id}`;
  const markdown = await fetchReaderMarkdown(rankUrl);
  const rankedTemplate = parsePikuRankMarkdown(markdown, canonicalUrl);
  return {
    ...metadata,
    ...rankedTemplate,
    title: metadata.title || rankedTemplate.title,
    totalCandidateCount: Math.max(metadata.totalCandidateCount || 0, rankedTemplate.totalCandidateCount || 0),
    bracketOptions: metadata.bracketOptions?.length ? metadata.bracketOptions : rankedTemplate.bracketOptions || [],
  };
}

function pickPikuBracketSize(requestedSize, template) {
  const requested = normalizeWorldcupBracketSize(requestedSize);
  const options = getTemplateBracketOptionSizes(template);
  if (requested && (!options.length || options.includes(requested))) return requested;

  const defaultSize = normalizeWorldcupBracketSize(template.defaultBracketSize || template.bracketSize);
  const supported = options.filter((size) => size <= MAX_WORLDCUP_BRACKET_SIZE).sort((a, b) => a - b);
  return (
    supported.at(-1) ||
    defaultSize ||
    getEffectiveWorldcupBracketSize(0, template.totalCandidateCount || template.items?.length || 0)
  );
}

function getTemplateBracketOptionSizes(template) {
  return uniqueNumbers(
    (template.bracketOptions || [])
      .filter((option) => option?.enabled !== false && option?.importable !== false)
      .map((option) => normalizeWorldcupBracketSize(option.size))
  );
}

function getLargestTemplateBracketSize(template, maxCount = 0) {
  const count = Number(maxCount || template.totalCandidateCount || template.availableItemCount || template.items?.length || 0);
  return getTemplateBracketOptionSizes(template)
    .filter((size) => !count || size <= count)
    .sort((a, b) => a - b)
    .at(-1) || 0;
}

async function importPikuRankDataTemplate(canonicalUrl, bracketSize, metadata) {
  const id = getPikuWorldcupId(canonicalUrl);
  const targetCount = Math.min(
    normalizeWorldcupBracketSize(bracketSize) || metadata.defaultBracketSize || metadata.totalCandidateCount || 0,
    MAX_WORLDCUP_BRACKET_SIZE
  );
  const requestLength = Math.max(targetCount, Math.min(metadata.totalCandidateCount || targetCount, MAX_WORLDCUP_BRACKET_SIZE));
  const jsonText = await fetchPikuTextWithCurl(`https://www.piku.co.kr/w/rank/x.php?u=${encodeURIComponent(id)}`, {
    method: "POST",
    data: `draw=1&start=0&length=${encodeURIComponent(String(requestLength))}`,
    referer: `https://www.piku.co.kr/w/rank/${id}`,
    xhr: true,
  });
  const payload = JSON.parse(jsonText);
  const rows = Array.isArray(payload.data) ? payload.data : [];
  const items = parsePikuRankDataRows(rows, canonicalUrl, metadata.title).slice(0, targetCount);
  const totalCandidateCount = Math.max(
    Number(payload.recordsTotal || 0),
    Number(payload.recordsFiltered || 0),
    metadata.totalCandidateCount || 0,
    items.length
  );

  return {
    ...metadata,
    importedVia: "piku-rank-json",
    bracketSize: targetCount,
    availableItemCount: items.length,
    totalCandidateCount,
    items,
  };
}

function parsePikuRankDataRows(rows, sourceUrl, templateTitle) {
  return rows
    .map((row, index) => {
      const imageHtml = String(row?.[1] || "");
      const nameHtml = String(row?.[2] || "");
      const imageDoc = cheerio.load(imageHtml);
      const nameDoc = cheerio.load(nameHtml);
      const src = normalizePikuImageUrl(
        imageDoc("a").first().attr("href") ||
          imageHtml.match(/background-image\s*:\s*url\(['"]?([^'")]+)['"]?\)/i)?.[1] ||
          "",
        sourceUrl
      );
      const alt = cleanPikuItemName(
        nameDoc.text() || imageDoc("a").first().attr("title") || imageDoc("[title]").first().attr("title") || ""
      );
      if (!src) return null;
      return {
        id: `piku-rank-${String(row?.[0] || index + 1).replace(/\D/g, "") || index + 1}-${hashId(src)}`,
        src,
        alt: alt || `후보 ${index + 1}`,
        placeholderSrc: createTextTileDataUrl(alt || `후보 ${index + 1}`, templateTitle),
      };
    })
    .filter(Boolean);
}

async function collectPikuWorldcupItems(canonicalUrl, bracketSize, metadata) {
  const id = getPikuWorldcupId(canonicalUrl);
  const cookieJar = createPikuCookieJarPath();
  const itemsByKey = new Map();
  const targetCount = Math.min(
    normalizeWorldcupBracketSize(bracketSize) || metadata.defaultBracketSize || metadata.totalCandidateCount || 0,
    MAX_WORLDCUP_BRACKET_SIZE
  );
  const maxMatches = Math.max(targetCount + PIKU_CRAWL_EXTRA_MATCH_LIMIT, Math.ceil(targetCount * 1.25));

  try {
    await fetchPikuTextWithCurl(canonicalUrl, { cookieJar });
    const resetResponse = await fetchPikuTextWithCurl(`https://www.piku.co.kr/w/play_reset.php`, {
      method: "POST",
      data: `tr=${encodeURIComponent(String(targetCount))}&pw=&u=${encodeURIComponent(id)}`,
      cookieJar,
      referer: canonicalUrl,
      xhr: true,
    });
    if (!/"mode"\s*:\s*"true"/i.test(resetResponse)) {
      throw new Error("PIKU 월드컵을 시작하지 못했습니다.");
    }

    let html = await fetchPikuPlayableHtml(canonicalUrl, { cookieJar });
    for (let matchIndex = 0; matchIndex < maxMatches && itemsByKey.size < targetCount; matchIndex += 1) {
      const match = parsePikuMatchHtml(html, canonicalUrl, metadata.title);
      for (const item of [match.left, match.right]) {
        const key = item?.pikuItemId || item?.src || "";
        if (key && !itemsByKey.has(key)) {
          itemsByKey.set(key, item);
        }
      }

      const winnerId = match.left?.pikuItemId || match.right?.pikuItemId || "";
      const loserId = match.left?.pikuItemId && match.right?.pikuItemId ? match.right.pikuItemId : "";
      if (!match.playToken || !winnerId) {
        if (isBlockedHtml(html)) {
          html = await fetchPikuPlayableHtml(canonicalUrl, { cookieJar });
          matchIndex -= 1;
          continue;
        }
        break;
      }

      await fetchPikuTextWithCurl(`https://www.piku.co.kr/w/play.php`, {
        method: "POST",
        data: `u=${encodeURIComponent(id)}&p=${encodeURIComponent(match.playToken)}&w=${encodeURIComponent(
          winnerId
        )}&l=${encodeURIComponent(loserId)}`,
        cookieJar,
        referer: canonicalUrl,
        xhr: true,
      });
      await delay(PIKU_CRAWL_DELAY_MS);
      html = await fetchPikuPlayableHtml(canonicalUrl, { cookieJar });
    }
  } finally {
    cleanupPikuCookieJar(cookieJar);
  }

  const items = Array.from(itemsByKey.values()).slice(0, targetCount).map((item, index) => ({
    ...item,
    id: `piku-${item.pikuItemId || hashId(item.src)}-${index}`,
  }));

  return {
    ...metadata,
    importedVia: "piku-play-crawl",
    bracketSize: targetCount,
    availableItemCount: items.length,
    totalCandidateCount: Math.max(metadata.totalCandidateCount || 0, items.length),
    items,
  };
}

async function fetchPikuPlayableHtml(canonicalUrl, options = {}) {
  for (let attempt = 0; attempt <= PIKU_CRAWL_MAX_BLOCK_RETRIES; attempt += 1) {
    const html = await fetchPikuTextWithCurl(canonicalUrl, options);
    if (!isBlockedHtml(html)) return html;
    await delay(PIKU_CRAWL_BLOCK_RETRY_DELAY_MS * (attempt + 1));
  }
  throw new Error("PIKU 원본 사이트가 일시적으로 요청을 제한했습니다. 잠시 후 다시 시도해주세요.");
}

function parsePikuStartHtml(html, sourceUrl) {
  const $ = cheerio.load(html);
  const title = cleanPikuTitle(
    $(".modal-title").first().text().trim() ||
      $("meta[property='og:title']").attr("content") ||
      $("title").first().text().trim() ||
      "PIKU 이상형월드컵"
  );
  const description = cleanPikuTitle(
    $(".modal-desc").first().text().trim() || $("meta[property='og:description']").attr("content") || ""
  );
  const totalCandidateCount = Math.max(
    inferPikuCandidateCount(`${title}\n${description}\n${$("#selRound").attr("name") || ""}\n${$("#rtext").text()}`),
    Number($("#selRound").attr("name") || 0) || 0
  );
  const defaultBracketSize =
    normalizeWorldcupBracketSize($("#selRound option[selected]").first().attr("value")) ||
    normalizeWorldcupBracketSize($("#selRound").val()) ||
    0;
  const optionSizes = $("#selRound option")
    .map((_index, option) => normalizeWorldcupBracketSize($(option).attr("value")))
    .get()
    .filter(Boolean);
  const bracketOptions = getWorldcupBracketOptions(
    totalCandidateCount,
    totalCandidateCount,
    optionSizes.length ? optionSizes : WORLDCUP_BRACKET_SIZES
  );

  return {
    mode: ROOM_MODE_WORLDCUP,
    title,
    description,
    sourceUrl,
    sourceKey: createSourceKey(sourceUrl, ROOM_MODE_WORLDCUP),
    importedVia: "piku-start-html",
    totalCandidateCount,
    availableItemCount: totalCandidateCount,
    bracketSize: defaultBracketSize || getEffectiveWorldcupBracketSize(0, totalCandidateCount, optionSizes),
    defaultBracketSize,
    bracketOptions,
    tiers: [],
    items: [],
  };
}

function parsePikuMatchHtml(html, sourceUrl, templateTitle) {
  const $ = cheerio.load(html);
  const playToken =
    String(html || "").match(/data\s*:\s*["']u=[^&"']+&p=([^&"']+)&w=/i)?.[1] ||
    String(html || "").match(/data\s*:\s*["'][^"']*?&p=([^&"']+)&w=/i)?.[1] ||
    "";
  return {
    playToken,
    left: parsePikuMatchItem($, "#wleft", "#wleftn", templateTitle, sourceUrl),
    right: parsePikuMatchItem($, "#wright", "#wrightn", templateTitle, sourceUrl),
  };
}

function parsePikuMatchItem($, itemSelector, nameSelector, templateTitle, sourceUrl) {
  const element = $(itemSelector).first();
  if (!element.length) return null;

  const style = element.attr("style") || "";
  const src = normalizePikuImageUrl(
    style.match(/background-image\s*:\s*url\(['"]?([^'")]+)['"]?\)/i)?.[1] || "",
    sourceUrl
  );
  const pikuItemId = String(element.attr("name") || "").trim();
  const alt = cleanPikuItemName($(nameSelector).first().text().trim()) || `후보 ${pikuItemId || ""}`.trim();
  if (!src) return null;

  return {
    pikuItemId,
    src,
    alt,
    placeholderSrc: createTextTileDataUrl(alt, templateTitle),
  };
}

async function enrichPikuTemplateImages(template) {
  const items = template.items || [];
  const enrichedItems = [];
  for (let index = 0; index < items.length; index += PIKU_IMAGE_ENRICH_CONCURRENCY) {
    const batch = items.slice(index, index + PIKU_IMAGE_ENRICH_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async (item) => {
        const imageUrl = await findPublicImageForPikuItem(item, template.title);
        if (!imageUrl) return item;
        return {
          ...item,
          originalSrc: item.originalSrc || item.src,
          src: imageUrl,
        };
      })
    );
    settled.forEach((result, offset) => {
      enrichedItems.push(result.status === "fulfilled" ? result.value : batch[offset]);
    });
  }
  return {
    ...template,
    items: enrichedItems,
  };
}

async function findPublicImageForPikuItem(item, templateTitle) {
  const query = buildPikuImageSearchQuery(item.alt, templateTitle);
  if (!query) return "";

  const cached = getCachedImageSearchResult(query);
  if (cached !== null) return cached;

  try {
    const results = await searchDuckDuckGoImages(query);
    const candidates = getRankedImageCandidates(results, item.alt, templateTitle);

    for (const imageUrl of candidates) {
      try {
        await fetchAndCacheImage(imageUrl);
        setCachedImageSearchResult(query, imageUrl);
        return imageUrl;
      } catch (_error) {
        // Keep trying the next image search candidate.
      }
    }
  } catch (_error) {
    // The text placeholder remains available when image search is unavailable.
  }

  setCachedImageSearchResult(query, "");
  return "";
}

function buildPikuImageSearchQuery(itemName, templateTitle) {
  const name = cleanPikuItemName(itemName);
  const context = cleanPikuTitle(templateTitle)
    .replace(/(?:이상형\s*)?월드컵|랭킹|인기투표|최애|최고|\(\s*\d{4}\s*년?\s*\)|[★☆]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return unique([name, context, "이미지"])
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}

function getRankedImageCandidates(results, itemName, templateTitle) {
  const seen = new Set();
  const candidates = [];
  for (const result of results || []) {
    const score = scoreImageSearchResult(result, itemName, templateTitle);
    for (const [index, rawUrl] of [result.image, result.thumbnail].entries()) {
      const url = normalizePublicImageUrl(rawUrl);
      if (!url || isPikuImageUrl(url) || seen.has(url)) continue;
      seen.add(url);
      candidates.push({
        url,
        score: score - index * 8 + scoreImageUrl(url),
      });
    }
  }
  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, PIKU_IMAGE_CANDIDATE_LIMIT)
    .map((candidate) => candidate.url);
}

function scoreImageSearchResult(result, itemName, templateTitle) {
  const itemText = normalizeSearchText(cleanPikuItemName(itemName));
  const itemTokens = getSignificantSearchTokens(itemText);
  const contextTokens = getSignificantSearchTokens(
    cleanPikuTitle(templateTitle).replace(/(?:이상형\s*)?월드컵|랭킹|인기투표|최애|최고|[★☆]/g, " ")
  );
  const haystack = normalizeSearchText(
    `${result?.title || ""} ${result?.source || ""} ${result?.url || ""} ${result?.image || ""}`
  );
  let score = 0;

  if (itemText && haystack.includes(itemText)) score += 140;
  for (const token of itemTokens) {
    if (haystack.includes(token)) score += 38;
  }
  for (const token of contextTokens.slice(0, 4)) {
    if (haystack.includes(token)) score += 8;
  }

  const width = Number(result?.width || 0);
  const height = Number(result?.height || 0);
  if (width >= 220 && height >= 220) score += 18;
  if (width >= 500 && height >= 500) score += 8;
  if (width && height) {
    const ratio = Math.max(width, height) / Math.max(1, Math.min(width, height));
    if (ratio > 2.4) score -= 18;
  }

  if (/youtube|youtu\.be|ytimg|maxresdefault|hqdefault|mqdefault/i.test(haystack)) score -= 35;
  if (/logo|icon|favicon|sprite|banner|thumbnail/i.test(haystack)) score -= 24;
  if (/namu\.wiki|fandom|wikipedia/i.test(haystack)) score -= 8;
  return score;
}

function scoreImageUrl(url) {
  if (/bing\.net\/th\/id\//i.test(url)) return 10;
  if (/pinimg\.com|static\.inven\.co\.kr|pbs\.twimg\.com|blog|tistory|namu/i.test(url)) return 4;
  if (/youtube|ytimg|pngwing|pngtree/i.test(url)) return -16;
  return 0;
}

function getSignificantSearchTokens(value) {
  return normalizeSearchText(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !/^(월드컵|이상형|랭킹|인기투표|이미지|사진|후보|캐릭터|아이돌)$/.test(token));
}

async function searchDuckDuckGoImages(query) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_SEARCH_TIMEOUT_MS);
  try {
    const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`;
    const htmlResponse = await fetch(searchUrl, {
      signal: controller.signal,
      headers: getBrowserLikeHeaders("https://duckduckgo.com/"),
    });
    if (!htmlResponse.ok) throw createHttpError(`Image search returned ${htmlResponse.status}`, htmlResponse.status);
    const html = await htmlResponse.text();
    const vqd =
      html.match(/vqd=['"]?([^'"&]+)['"]?/)?.[1] ||
      html.match(/"vqd"\s*:\s*"([^"]+)"/)?.[1] ||
      "";
    if (!vqd) return [];

    const apiUrl = `https://duckduckgo.com/i.js?l=wt-wt&o=json&q=${encodeURIComponent(query)}&vqd=${encodeURIComponent(
      vqd
    )}&f=,,,&p=1`;
    const response = await fetch(apiUrl, {
      signal: controller.signal,
      headers: {
        ...getBrowserLikeHeaders("https://duckduckgo.com/"),
        accept: "application/json,text/javascript,*/*;q=0.8",
      },
    });
    if (!response.ok) throw createHttpError(`Image search returned ${response.status}`, response.status);
    const data = await response.json();
    return Array.isArray(data.results) ? data.results : [];
  } finally {
    clearTimeout(timeout);
  }
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

async function searchPikuWorldcups(query) {
  const term = String(query || "").trim().slice(0, 80);
  const cacheKey = normalizeSearchText(term) || "__home__";
  const cachedResults = getCachedPikuSearchResults(cacheKey);
  if (cachedResults) return cachedResults;

  const sources = [];
  const pikuSearchUrl = term
    ? `https://www.piku.co.kr/w/search/${encodeURIComponent(term)}`
    : "https://www.piku.co.kr/";
  sources.push(fetchReaderMarkdown(pikuSearchUrl).then((markdown) => parsePikuSearchMarkdown(markdown, term, 20)));

  if (term) {
    const ddgUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(`site:piku.co.kr/w/ ${term} 이상형 월드컵`)}`;
    sources.push(searchPikuWorldcupsViaDuckDuckGo(ddgUrl, term));
    const broadDdgUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(`site:piku.co.kr/w/ ${term}`)}`;
    sources.push(searchPikuWorldcupsViaDuckDuckGo(broadDdgUrl, term));
  }

  const settled = await Promise.allSettled(sources);
  const templates = [];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      templates.push(...result.value);
    }
  }

  const scored = templates
    .map((template) => ({
      ...template,
      score: scorePikuTemplate(template, term) + Number(template.scoreBoost || 0),
    }))
    .filter((template) => !term || template.score > 0)
    .sort((a, b) => b.score - a.score);

  const verified = await filterImportablePikuTemplates(scored);
  const results = uniqueTemplates(verified.length ? verified : uniquePikuSearchTemplates(scored)).slice(0, 18);
  setCachedPikuSearchResults(cacheKey, results);
  return results;
}

async function filterImportablePikuTemplates(templates) {
  const unique = uniquePikuSearchTemplates(templates).slice(0, 14);
  const checked = await Promise.allSettled(
    unique.map(async (template) => {
      const candidateCount = await getPikuImportableCandidateCount(template.url);
      return candidateCount >= 2 ? { ...template, candidateCount } : null;
    })
  );
  return checked
    .filter((result) => result.status === "fulfilled" && result.value)
    .map((result) => result.value);
}

async function searchPikuWorldcupsViaDuckDuckGo(ddgUrl, term) {
  try {
    const markdown = await fetchReaderMarkdown(ddgUrl);
    const parsed = parsePikuExternalSearchMarkdown(markdown, term);
    if (parsed.length) return parsed;
  } catch (_error) {
    // Fall through to the raw HTML parser below.
  }

  const response = await fetch(ddgUrl, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });
  if (!response.ok) throw new Error(`DuckDuckGo returned ${response.status}`);
  return parsePikuExternalSearchHtml(await response.text(), term);
}

async function getPikuImportableCandidateCount(sourceUrl) {
  try {
    const canonicalUrl = normalizePikuWorldcupUrl(sourceUrl);
    const metadata = await fetchPikuWorldcupMetadata(canonicalUrl);
    return metadata.totalCandidateCount || metadata.availableItemCount || metadata.items.length;
  } catch (_error) {
    return 0;
  }
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

function parsePikuSearchMarkdown(markdown, query, scoreBoost = 0) {
  const lines = String(markdown || "").split(/\r?\n/).map((line) => line.trim());
  const templates = [];
  let pendingTitle = "";
  let pendingText = "";

  for (const line of lines) {
    const titleMatch = line.match(/^\[([^\]]+)]\(https?:\/\/(?:www\.)?piku\.co\.kr\/(?:w\/search\/[^#)]+#|#)\)$/i);
    if (titleMatch) {
      pendingTitle = cleanPikuTitle(titleMatch[1]);
      pendingText = "";
      continue;
    }

    const startMatch = line.match(/\[시작하기]\((https?:\/\/(?:www\.)?piku\.co\.kr\/w\/[A-Za-z0-9]+)\)/i);
    if (startMatch) {
      const url = normalizePikuSearchUrl(startMatch[1]);
      if (url) {
        templates.push({
          title: pendingTitle || "PIKU 이상형월드컵",
          url,
          sourceKey: createSourceKey(url, ROOM_MODE_WORLDCUP),
          description: pendingText,
          scoreBoost,
        });
      }
      pendingTitle = "";
      pendingText = "";
      continue;
    }

    if (pendingTitle && line && !/^\[랭킹보기]|\[시작하기]/.test(line)) {
      pendingText = `${pendingText} ${stripMarkdownLine(line)}`.trim().slice(0, 180);
    }
  }

  const normalizedQuery = normalizeSearchText(query);
  const cleaned = templates.map((template) => ({
    title: template.title,
    url: template.url,
    sourceKey: template.sourceKey,
    description: template.description,
    scoreBoost: template.scoreBoost || 0,
  }));

  if (!normalizedQuery) return cleaned;
  return cleaned.filter((template) => scorePikuTemplate(template, query) > 0);
}

function parsePikuExternalSearchMarkdown(markdown, query) {
  const links = Array.from(String(markdown || "").matchAll(/\[([^\]]+)]\((https?:\/\/[^)]+)\)/g));
  const templates = [];
  for (const match of links) {
    const url = normalizePikuSearchUrl(match[2]);
    if (!url) continue;
    const title = cleanPikuTitle(match[1]).replace(/^Piku\s+-\s*/i, "");
    if (!title || /DuckDuckGo|Image\s+\d+/i.test(title)) continue;
    templates.push({
      title,
      url,
      sourceKey: createSourceKey(url, ROOM_MODE_WORLDCUP),
      description: "",
      scoreBoost: 80,
    });
  }
  return templates.filter((template) => scorePikuTemplate(template, query) > 0);
}

function parsePikuExternalSearchHtml(html, query) {
  const $ = cheerio.load(html);
  const templates = [];
  $(".result").each((_index, result) => {
    const resultElement = $(result);
    const link = resultElement.find("a.result__a").first();
    const url = normalizePikuSearchUrl(link.attr("href") || "");
    if (!url) return;
    const title = cleanPikuTitle(link.text());
    const description = cleanPikuTitle(resultElement.find(".result__snippet").first().text());
    const template = {
      title: title || description || "PIKU 이상형월드컵",
      url,
      sourceKey: createSourceKey(url, ROOM_MODE_WORLDCUP),
      description,
      scoreBoost: 80,
    };
    if (scorePikuTemplate(template, query) > 0) {
      templates.push(template);
    }
  });
  return templates;
}

function scorePikuTemplate(template, query) {
  const words = normalizeSearchText(query).split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const title = normalizeSearchText(template.title);
  const description = normalizeSearchText(template.description);
  const haystack = `${title} ${description}`;
  const titleHits = words.filter((word) => title.includes(word)).length;
  const descriptionHits = words.filter((word) => description.includes(word)).length;
  if (titleHits === words.length) return 100 + titleHits * 5;
  if (titleHits > 0) return 60 + titleHits * 5;
  if (descriptionHits === words.length) return 35 + descriptionHits * 3;
  if (descriptionHits > 0) return 15 + descriptionHits * 3;
  return haystack.includes(words.join(" ")) ? 10 : 0;
}

function parsePikuRankMarkdown(markdown, sourceUrl) {
  const title = cleanPikuTitle(
    String(markdown || "").match(/^Title:\s*(.+)$/m)?.[1] ||
      String(markdown || "").match(/^#+\s*(.+?)\s+랭킹/m)?.[1] ||
      "PIKU 이상형월드컵"
  );
  const totalCandidateCount = inferPikuCandidateCount(`${title}\n${markdown}`);
  const items = [];
  const rowRegex = /\|\s*\d+\s*\|\s*\[]\((https?:\/\/img\.piku\.co\.kr\/[^)\s]+)(?:\s+"([^"]*)")?\)\s*\|\s*\*\*([^*]+)\*\*/gi;

  for (const match of String(markdown || "").matchAll(rowRegex)) {
    const src = normalizePikuImageUrl(match[1]);
    const alt = cleanPikuItemName(match[3] || match[2] || "");
    if (!src) continue;
    items.push({
      id: `piku-${hashId(src)}-${items.length}`,
      src,
      alt: alt || `후보 ${items.length + 1}`,
      placeholderSrc: createTextTileDataUrl(alt || `후보 ${items.length + 1}`, title),
    });
  }

  if (!items.length) {
    for (const match of String(markdown || "").matchAll(/\[]\((https?:\/\/img\.piku\.co\.kr\/[^)\s]+)(?:\s+"([^"]*)")?\)/gi)) {
      const src = normalizePikuImageUrl(match[1]);
      const alt = cleanPikuItemName(match[2] || "");
      if (!src) continue;
      items.push({
        id: `piku-${hashId(src)}-${items.length}`,
        src,
        alt: alt || `후보 ${items.length + 1}`,
        placeholderSrc: createTextTileDataUrl(alt || `후보 ${items.length + 1}`, title),
      });
    }
  }

  return {
    mode: ROOM_MODE_WORLDCUP,
    title,
    sourceUrl,
    sourceKey: createSourceKey(sourceUrl, ROOM_MODE_WORLDCUP),
    importedVia: "piku-rank",
    totalCandidateCount: Math.max(totalCandidateCount, items.length),
    tiers: [],
    items: uniqueItemsBySrc(items).slice(0, MAX_SNAPSHOT_ITEMS),
  };
}

function inferPikuCandidateCount(value) {
  const text = String(value || "");
  const counts = [];
  for (const match of text.matchAll(/총\s*(\d{1,4})\s*명/g)) {
    counts.push(Number(match[1]));
  }
  for (const match of text.matchAll(/(\d{1,4})\s*강/g)) {
    counts.push(Number(match[1]));
  }
  return Math.max(0, ...counts.filter((count) => Number.isFinite(count) && count >= 4));
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

function uniquePikuSearchTemplates(templates) {
  const byKey = new Map();
  for (const template of templates) {
    const sourceKey = template.sourceKey || createSourceKey(template.url, ROOM_MODE_WORLDCUP);
    if (!template.url) continue;
    const next = {
      ...template,
      sourceKey,
    };
    const current = byKey.get(sourceKey);
    if (!current || getPikuSearchTitleQuality(next) > getPikuSearchTitleQuality(current)) {
      byKey.set(sourceKey, next);
    }
  }
  return Array.from(byKey.values()).sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
}

function getPikuSearchTitleQuality(template) {
  const title = normalizeSearchText(template.title);
  let quality = Number(template.score || 0);
  if (title && title !== normalizeSearchText("PIKU 이상형월드컵")) quality += 20;
  if (title.includes("이상형") || title.includes("월드컵")) quality += 10;
  quality += Math.min(title.length, 60) / 10;
  return quality;
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

async function fetchPikuTextWithCurl(sourceUrl, options = {}) {
  const args = [
    "-sS",
    "-L",
    "--max-time",
    String(PIKU_CURL_TIMEOUT_SECONDS),
    "-A",
    getCurlBrowserUserAgent(),
    "-H",
    "Accept-Language: ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    "-H",
    options.xhr ? "Accept: */*" : "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  ];

  if (options.cookieJar) {
    args.push("-c", options.cookieJar, "-b", options.cookieJar);
  }
  if (options.referer) {
    args.push("-e", options.referer);
  }
  if (options.method === "POST") {
    args.push(
      "-H",
      "Content-Type: application/x-www-form-urlencoded; charset=UTF-8",
      "-H",
      "X-Requested-With: XMLHttpRequest",
      "--data",
      String(options.data || "")
    );
  }

  args.push(sourceUrl);
  const buffer = await runCurl(args, { maxBuffer: MAX_HTML_IMPORT_LENGTH + 1_000_000 });
  return buffer.toString("utf8");
}

async function fetchPikuImageWithCurl(imageUrl) {
  const buffer = await runCurl(
    [
      "-sS",
      "-L",
      "--max-time",
      String(PIKU_CURL_TIMEOUT_SECONDS),
      "-A",
      getCurlBrowserUserAgent(),
      "-H",
      "Accept: image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "-e",
      "https://www.piku.co.kr/",
      imageUrl,
    ],
    { maxBuffer: MAX_PROXY_IMAGE_BYTES + 512_000 }
  );

  if (buffer.length > MAX_PROXY_IMAGE_BYTES) {
    throw createHttpError("Image is too large.", 413);
  }

  const contentType = detectImageContentType(buffer, imageUrl);
  if (!contentType) {
    throw createHttpError("Image fetch returned non-image content.", 502);
  }

  return { buffer, contentType };
}

function runCurl(args, options = {}) {
  const command = process.platform === "win32" ? "curl.exe" : "curl";
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "buffer",
        maxBuffer: options.maxBuffer || MAX_HTML_IMPORT_LENGTH,
        timeout: (PIKU_CURL_TIMEOUT_SECONDS + 5) * 1000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = Buffer.isBuffer(stderr) ? stderr.toString("utf8").trim() : "";
          reject(new Error(message || error.message || "curl 실행에 실패했습니다."));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

function getCurlBrowserUserAgent() {
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";
}

function createPikuCookieJarPath() {
  return path.join(os.tmpdir(), `mtm-piku-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.txt`);
}

function cleanupPikuCookieJar(cookieJar) {
  if (!cookieJar) return;
  fs.rm(cookieJar, { force: true }, () => {});
}

async function fetchReaderMarkdown(sourceUrl) {
  const readerUrls = [
    `https://r.jina.ai/${sourceUrl}`,
    `https://r.jina.ai/http://r.jina.ai/http://${sourceUrl}`,
  ];
  let lastError = null;

  for (const readerUrl of readerUrls) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(readerUrl, {
          headers: {
            accept: "text/plain,text/markdown,*/*",
            "user-agent": "MultiplayTierMaker/1.0",
          },
        });
        if (!response.ok) {
          lastError = new Error(`Reader returned ${response.status}`);
          continue;
        }
        const text = await response.text();
        if (text.trim()) return text;
        lastError = new Error("Reader returned empty content");
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError || new Error("링크 내용을 읽지 못했습니다. 잠시 후 다시 시도해주세요.");
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
  const sourceKey = createSourceKey(sourceUrl, ROOM_MODE_TIERMAKER);
  const tiers = (rowTexts.length ? rowTexts : ["S", "A", "B", "C", "D"]).map((label, index) => ({
    id: `tier-${index + 1}`,
    label,
    color: TIER_COLORS[index % TIER_COLORS.length],
  }));

  return {
    mode: ROOM_MODE_TIERMAKER,
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

function normalizePikuWorldcupUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("PIKU 이상형월드컵 링크를 입력해주세요.");

  const repaired = raw.replace(/\s+/g, "").replace(/\/+$/g, "");
  const withProtocol = /^https?:\/\//i.test(repaired) ? repaired : `https://${repaired}`;
  const url = new URL(withProtocol);

  if (!/(^|\.)piku\.co\.kr$/i.test(url.hostname)) {
    throw new Error("piku.co.kr/w/... 형식의 이상형월드컵 링크만 지원합니다.");
  }

  const id = getPikuWorldcupId(url.toString());
  if (!id) {
    throw new Error("piku.co.kr/w/... 또는 piku.co.kr/w/rank/... 링크만 지원합니다.");
  }

  return `https://www.piku.co.kr/w/${id}`;
}

function normalizePikuSearchUrl(rawUrl) {
  try {
    let url = new URL(rawUrl, "https://duckduckgo.com");
    if (url.hostname.includes("duckduckgo.com") && url.pathname === "/l/") {
      const nestedUrl = url.searchParams.get("uddg");
      if (!nestedUrl) return "";
      url = new URL(nestedUrl);
    }
    return normalizePikuWorldcupUrl(url.toString());
  } catch (_error) {
    return "";
  }
}

function getPikuWorldcupId(sourceUrl) {
  try {
    const url = new URL(sourceUrl);
    const match = url.pathname.match(/^\/w\/(?:rank\/)?([A-Za-z0-9]+)\/?$/);
    return match?.[1] || "";
  } catch (_error) {
    return "";
  }
}

function createSourceKey(sourceUrl, mode = ROOM_MODE_TIERMAKER, options = {}) {
  if (!sourceUrl) return sourceUrl;
  try {
    const url = new URL(sourceUrl);
    url.hash = "";
    url.searchParams.delete("presentationMode");
    url.searchParams.sort();
    const normalizedMode = normalizeRoomMode(mode);
    const optionKey =
      normalizedMode === ROOM_MODE_WORLDCUP
        ? `:bracket=${normalizeWorldcupBracketSize(options.bracketSize) || "auto"}`
        : "";
    return `${normalizedMode}:${url.origin}${url.pathname.replace(/\/+$/, "")}${url.search}${optionKey}`;
  } catch (_error) {
    const normalizedMode = normalizeRoomMode(mode);
    const optionKey =
      normalizedMode === ROOM_MODE_WORLDCUP
        ? `:bracket=${normalizeWorldcupBracketSize(options.bracketSize) || "auto"}`
        : "";
    return `${normalizedMode}:${sourceUrl}${optionKey}`;
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

function cleanPikuTitle(value) {
  return String(value || "PIKU 이상형월드컵")
    .replace(/\*\*/g, "")
    .replace(/^Piku\s+-\s*/i, "")
    .replace(/^이상형\s*월드컵\s*-\s*/i, "")
    .replace(/^이상형\s*월드컵\s*랭킹\s*-\s*/i, "")
    .replace(/\s+Piku$/i, "")
    .replace(/\s+Ideal type worldcup PIKU$/i, "")
    .replace(/\s+Ideal type worldcup$/i, "")
    .replace(/[을를]\s+즐겨보세요\..*$/i, "")
    .replace(/\s+이상형월드컵을\s+직접\s+만들수도\s+있습니다.*$/i, "")
    .replace(/\s+\d+강\s*\|.*$/i, "")
    .replace(/\s+최신화\s*\([^)]*\)\s+기준.*$/i, "")
    .replace(/\s+총\s+라운드를\s+선택하세요.*$/i, "")
    .replace(/\s+총\s+\d+명의\s+후보.*$/i, "")
    .replace(/\s+랭킹\s*\(.*?\)\s*$/i, "")
    .replace(/\s+랭킹$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanPikuItemName(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CUSTOM_ITEM_ALT_LENGTH);
}

function createTextTileDataUrl(label, subtitle = "") {
  const title = escapeSvgText(String(label || "후보").slice(0, 42));
  const caption = escapeSvgText(cleanPikuTitle(subtitle).slice(0, 54));
  const hue = Number.parseInt(hashId(`${label}:${subtitle}`).slice(0, 2), 16) % 360;
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="360" height="360" viewBox="0 0 360 360">
  <rect width="360" height="360" fill="hsl(${hue}, 52%, 18%)"/>
  <path d="M0 0h360v360H0z" fill="none" stroke="hsla(${hue}, 80%, 74%, .38)" stroke-width="8"/>
  <path d="M28 28h304v304H28z" fill="hsla(${hue}, 65%, 52%, .12)" stroke="hsla(${hue}, 90%, 72%, .34)" stroke-width="2"/>
  <text x="180" y="156" text-anchor="middle" fill="#f6efe3" font-family="Arial, sans-serif" font-size="31" font-weight="800">
    ${title}
  </text>
  <text x="180" y="204" text-anchor="middle" fill="#c9bead" font-family="Arial, sans-serif" font-size="15" font-weight="700">
    ${caption || "PIKU"}
  </text>
  <text x="180" y="306" text-anchor="middle" fill="#2dd4bf" font-family="Consolas, monospace" font-size="13" font-weight="700">
    PIKU RANK
  </text>
</svg>`.trim();
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function escapeSvgText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isBlockedHtml(html) {
  return /Just a moment|Enable JavaScript and cookies|challenge-error-text|challenge-platform|cdn-cgi\/challenge|cf_chl_opt/i.test(
    html
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSupportedImageUrl(value) {
  return normalizeTemplateImageUrl(value) || normalizePikuImageUrl(value) || normalizePublicImageUrl(value);
}

function isTemplateImageUrl(url) {
  return /https?:\/\/(?:www\.)?tiermaker\.com\/images\/+(?:media\/)?template_images\//i.test(url);
}

function normalizeTemplateImageUrl(value, baseUrl = "https://tiermaker.com") {
  const url = resolveUrl(cleanExtractedImageUrl(value), baseUrl);
  return isTemplateImageUrl(url) ? url : "";
}

function isPikuImageUrl(url) {
  return /^https?:\/\/img\.piku\.co\.kr\/w\/uploads\/[A-Za-z0-9]+\/[^"'`\s<>&)]+\.(?:jpe?g|png|webp|gif)$/i.test(url);
}

function normalizePikuImageUrl(value, baseUrl = "https://www.piku.co.kr") {
  const url = resolveUrl(cleanExtractedImageUrl(value), baseUrl);
  return isPikuImageUrl(url) ? url : "";
}

function normalizePublicImageUrl(value) {
  try {
    const url = new URL(cleanExtractedImageUrl(value));
    if (!["http:", "https:"].includes(url.protocol)) return "";
    if (isBlockedProxyHostname(url.hostname)) return "";
    url.username = "";
    url.password = "";
    return url.toString();
  } catch (_error) {
    return "";
  }
}

function isBlockedProxyHostname(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;

  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4Match) return false;

  const octets = ipv4Match.slice(1).map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true;
  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function cleanExtractedImageUrl(value) {
  return String(value || "")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .replace(/[)\].,;]+$/g, "")
    .trim();
}

async function fetchAndCacheImage(imageUrl) {
  const cached = imageCache.get(imageUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }

  if (isPikuImageUrl(imageUrl)) {
    const curlImage = await fetchPikuImageWithCurl(imageUrl);
    const cachedImage = {
      ...curlImage,
      expiresAt: Date.now() + IMAGE_CACHE_TTL_MS,
    };
    imageCache.set(imageUrl, cachedImage);
    return cachedImage;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const upstream = await fetch(imageUrl, {
      signal: controller.signal,
      headers: getImageFetchHeaders(imageUrl),
    });

    if (!upstream.ok) {
      throw createHttpError("Image fetch failed.", upstream.status);
    }

    const contentType = upstream.headers.get("content-type") || "image/png";
    if (!contentType.startsWith("image/")) {
      throw createHttpError("Image fetch returned non-image content.", 502);
    }

    const contentLength = Number(upstream.headers.get("content-length") || 0);
    if (contentLength > MAX_PROXY_IMAGE_BYTES) {
      throw createHttpError("Image is too large.", 413);
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.length > MAX_PROXY_IMAGE_BYTES) {
      throw createHttpError("Image is too large.", 413);
    }

    const cachedImage = {
      buffer,
      contentType,
      expiresAt: Date.now() + IMAGE_CACHE_TTL_MS,
    };
    imageCache.set(imageUrl, cachedImage);
    return cachedImage;
  } finally {
    clearTimeout(timeout);
  }
}

function detectImageContentType(buffer, imageUrl = "") {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return "";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  if (buffer.slice(0, 3).toString("ascii") === "GIF") return "image/gif";
  if (buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  const head = buffer.slice(0, 256).toString("utf8").trimStart();
  if (/^<!doctype html/i.test(head) || /^<html[\s>]/i.test(head)) return "";
  if (head.startsWith("<svg") || /^data:image\/svg\+xml/i.test(imageUrl)) return "image/svg+xml";
  if (/\.webp(?:$|[?#])/i.test(imageUrl)) return "image/webp";
  if (/\.png(?:$|[?#])/i.test(imageUrl)) return "image/png";
  if (/\.gif(?:$|[?#])/i.test(imageUrl)) return "image/gif";
  if (/\.jpe?g(?:$|[?#])/i.test(imageUrl)) return "image/jpeg";
  return "";
}

function getImageFetchHeaders(imageUrl) {
  return {
    ...getBrowserLikeHeaders(getImageReferer(imageUrl)),
    accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  };
}

function getBrowserLikeHeaders(referer = "") {
  const headers = {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
  };
  if (referer) headers.referer = referer;
  return headers;
}

function getImageReferer(imageUrl) {
  try {
    const hostname = new URL(imageUrl).hostname.toLowerCase();
    if (hostname.includes("img.piku.co.kr")) return "https://www.piku.co.kr/";
    if (hostname.includes("tiermaker.com")) return "https://tiermaker.com/";
    if (hostname.includes("bing.com") || hostname.includes("duckduckgo.com")) return "https://duckduckgo.com/";
  } catch (_error) {
    return "";
  }
  return "";
}

function createHttpError(message, statusCode = 500) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
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

function uniqueNumbers(values) {
  return Array.from(
    new Set(
      values
        .map((value) => Number(value || 0))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );
}

function uniqueItemsBySrc(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (!item?.src || seen.has(item.src)) continue;
    seen.add(item.src);
    result.push(item);
  }
  return result;
}

function getCachedPikuTemplate(sourceUrl, bracketSize = 0) {
  const key = createSourceKey(sourceUrl, ROOM_MODE_WORLDCUP, { bracketSize });
  const cached = pikuTemplateCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    pikuTemplateCache.delete(key);
    return null;
  }
  return cloneTemplate(cached.template);
}

function setCachedPikuTemplate(sourceUrl, template, bracketSize = 0) {
  const key = createSourceKey(sourceUrl, ROOM_MODE_WORLDCUP, { bracketSize });
  pikuTemplateCache.set(key, {
    template: cloneTemplate(template),
    expiresAt: Date.now() + PIKU_TEMPLATE_CACHE_TTL_MS,
  });
}

function getCachedPikuSearchResults(cacheKey) {
  const cached = pikuSearchCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    pikuSearchCache.delete(cacheKey);
    return null;
  }
  return cached.results.map((template) => ({ ...template }));
}

function setCachedPikuSearchResults(cacheKey, results) {
  pikuSearchCache.set(cacheKey, {
    results: results.map((template) => ({ ...template })),
    expiresAt: Date.now() + PIKU_SEARCH_CACHE_TTL_MS,
  });
}

function getCachedImageSearchResult(query) {
  const cacheKey = normalizeSearchText(query);
  if (!cacheKey) return "";
  const cached = imageSearchCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    imageSearchCache.delete(cacheKey);
    return null;
  }
  return cached.url || "";
}

function setCachedImageSearchResult(query, url) {
  const cacheKey = normalizeSearchText(query);
  if (!cacheKey) return;
  imageSearchCache.set(cacheKey, {
    url: url || "",
    expiresAt: Date.now() + IMAGE_SEARCH_CACHE_TTL_MS,
  });
}

function cloneTemplate(template) {
  return {
    ...template,
    tiers: (template.tiers || []).map((tier) => ({ ...tier })),
    items: (template.items || []).map((item) => ({ ...item })),
  };
}

function hashId(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 10);
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}
