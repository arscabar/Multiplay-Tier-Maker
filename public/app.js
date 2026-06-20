const socket = io();

const state = {
  nickname: localStorage.getItem("mtm:nickname") || "",
  currentRoom: null,
  rooms: [],
  pendingRoomId: "",
  roomError: "",
  publicBaseUrl: "",
  pendingTemplateUrl: "",
  draggedItemId: null,
  draggedTierId: null,
  activeItems: {},
  cursors: new Map(),
  lastCursorSentAt: 0,
};

const els = {
  homeButton: document.querySelector("#homeButton"),
  nicknameInput: document.querySelector("#nicknameInput"),
  profileForm: document.querySelector("#profileForm"),
  connectionStatus: document.querySelector("#connectionStatus"),
  createRoomForm: document.querySelector("#createRoomForm"),
  tierUrlInput: document.querySelector("#tierUrlInput"),
  importStatus: document.querySelector("#importStatus"),
  templateSearchForm: document.querySelector("#templateSearchForm"),
  templateSearchInput: document.querySelector("#templateSearchInput"),
  templateSearchStatus: document.querySelector("#templateSearchStatus"),
  templatePreview: document.querySelector("#templatePreview"),
  templateSearchResults: document.querySelector("#templateSearchResults"),
  refreshRoomsButton: document.querySelector("#refreshRoomsButton"),
  roomList: document.querySelector("#roomList"),
  playerList: document.querySelector("#playerList"),
  roomCodeLabel: document.querySelector("#roomCodeLabel"),
  workspaceTitle: document.querySelector("#workspaceTitle"),
  copyStatus: document.querySelector("#copyStatus"),
  addImageButton: document.querySelector("#addImageButton"),
  addTierButton: document.querySelector("#addTierButton"),
  imageUploadInput: document.querySelector("#imageUploadInput"),
  saveImageButton: document.querySelector("#saveImageButton"),
  copyRoomButton: document.querySelector("#copyRoomButton"),
  resetRoomButton: document.querySelector("#resetRoomButton"),
  deleteRoomButton: document.querySelector("#deleteRoomButton"),
  emptyState: document.querySelector("#emptyState"),
  emptyStateText: document.querySelector("#emptyStateText"),
  boardWrap: document.querySelector("#boardWrap"),
  tierBoard: document.querySelector("#tierBoard"),
  cursorLayer: document.querySelector("#cursorLayer"),
  imageLightbox: document.querySelector("#imageLightbox"),
  lightboxTitle: document.querySelector("#lightboxTitle"),
  lightboxImage: document.querySelector("#lightboxImage"),
  closeLightboxButton: document.querySelector("#closeLightboxButton"),
  closeLightboxBackdrop: document.querySelector("#closeLightboxBackdrop"),
  tierDialog: document.querySelector("#tierDialog"),
  tierDialogForm: document.querySelector("#tierDialogForm"),
  tierNameInput: document.querySelector("#tierNameInput"),
  tierDialogStatus: document.querySelector("#tierDialogStatus"),
  cancelTierDialogButton: document.querySelector("#cancelTierDialogButton"),
  closeTierDialogBackdrop: document.querySelector("#closeTierDialogBackdrop"),
};

els.nicknameInput.value = state.nickname;
setProfileEnabled();
loadConfig();
loadRooms();
handleTemplateImportFromQuery();

socket.on("connect", () => {
  els.connectionStatus.textContent = "온라인";
  els.connectionStatus.classList.add("is-online");
  joinRoomFromHash();
});

socket.on("disconnect", () => {
  els.connectionStatus.textContent = "오프라인";
  els.connectionStatus.classList.remove("is-online");
});

socket.on("rooms:update", (rooms) => {
  state.rooms = rooms;
  renderRooms();
});

socket.on("room:state", (room) => {
  state.currentRoom = room;
  state.pendingRoomId = "";
  state.roomError = "";
  state.activeItems = mapActiveItems(room.activeItems || []);
  state.cursors.clear();
  renderWorkspace();
});

socket.on("room:error", ({ message }) => {
  state.currentRoom = null;
  state.roomError = message;
  setImportStatus(message, true);
  renderWorkspace();
});

socket.on("room:deleted", ({ roomId }) => {
  const isCurrentRoom =
    state.currentRoom?.id === roomId || state.pendingRoomId === roomId || getRoomIdFromHash() === roomId;
  if (isCurrentRoom) {
    returnToHome("방이 삭제되어 메인 화면으로 돌아왔습니다.");
  }
});

socket.on("cursor:update", ({ playerId, nickname, color, cursor }) => {
  if (playerId === socket.id || !state.currentRoom) return;
  state.cursors.set(playerId, { nickname, color, cursor });
  renderCursors();
});

socket.on("cursor:remove", ({ playerId }) => {
  state.cursors.delete(playerId);
  renderCursors();
});

socket.on("item:focus", ({ activeItems }) => {
  state.activeItems = mapActiveItems(activeItems || []);
  renderItemHighlights();
});

els.profileForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.nickname = els.nicknameInput.value.trim().slice(0, 18);
  localStorage.setItem("mtm:nickname", state.nickname);
  setProfileEnabled();
  setImportStatus(state.nickname ? `${state.nickname} 닉네임으로 저장했습니다.` : "닉네임을 입력해주세요.", !state.nickname);
  if (state.pendingTemplateUrl) {
    consumePendingTemplateUrl();
    return;
  }
  joinRoomFromHash();
});

els.createRoomForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!requireNickname()) return;
  await createRoomFromLink(els.tierUrlInput.value);
});

els.templateSearchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await searchTemplates(els.templateSearchInput.value);
});
els.refreshRoomsButton.addEventListener("click", loadRooms);
els.homeButton.addEventListener("click", leaveRoomToHome);
els.addImageButton.addEventListener("click", () => {
  if (!state.currentRoom) return;
  els.imageUploadInput.value = "";
  els.imageUploadInput.click();
});
els.imageUploadInput.addEventListener("change", handleImageUpload);
els.addTierButton.addEventListener("click", openTierDialog);
els.saveImageButton.addEventListener("click", saveBoardImage);
els.copyRoomButton.addEventListener("click", copyRoomLink);
els.resetRoomButton.addEventListener("click", () => socket.emit("room:reset"));
els.deleteRoomButton.addEventListener("click", () => {
  const roomId = state.currentRoom?.id;
  if (roomId) deleteRoom(roomId);
});
els.closeLightboxButton.addEventListener("click", closeImagePreview);
els.closeLightboxBackdrop.addEventListener("click", () => {
  closeImagePreview();
  clearActiveItem();
});
els.cancelTierDialogButton.addEventListener("click", closeTierDialog);
els.closeTierDialogBackdrop.addEventListener("click", closeTierDialog);
els.tierDialogForm.addEventListener("submit", submitTierDialog);

window.addEventListener("hashchange", joinRoomFromHash);
window.addEventListener("pointermove", (event) => {
  if (!state.currentRoom || !socket.connected) return;
  const now = performance.now();
  if (now - state.lastCursorSentAt < 35) return;
  state.lastCursorSentAt = now;
  socket.emit("cursor:move", buildCursorPayload(event));
});
window.addEventListener("scroll", renderCursors, { passive: true });
els.boardWrap.addEventListener("scroll", renderCursors, { passive: true });
document.addEventListener("pointerdown", (event) => {
  if (!state.currentRoom) return;
  if (event.target.closest(".tier-item") || event.target.closest(".image-lightbox")) return;
  clearActiveItem();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.imageLightbox.hidden) {
    closeImagePreview();
  } else if (event.key === "Escape" && !els.tierDialog.hidden) {
    closeTierDialog();
  }
});

async function loadRooms() {
  const response = await fetch("/api/rooms");
  const data = await response.json();
  state.rooms = data.rooms || [];
  renderRooms();
}

async function loadConfig() {
  try {
    const response = await fetch("/api/config");
    const data = await response.json();
    state.publicBaseUrl = String(data.publicBaseUrl || "").replace(/\/+$/, "");
  } catch (_error) {
    state.publicBaseUrl = "";
  }
}

async function createRoomFromLink(url, options = {}) {
  const status = options.statusTarget === "search" ? setTemplateSearchStatus : setImportStatus;
  status("TierMaker 링크를 읽는 중입니다...");
  try {
    const response = await fetch("/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "가져오기에 실패했습니다.");
    status(
      data.existing
        ? "이미 열린 티어메이커입니다. 기존 방으로 입장합니다."
        : "방이 열렸습니다. 바로 입장합니다."
    );
    joinRoom(data.room.id);
  } catch (error) {
    status(error.message, true);
  }
}

async function createRoomFromSearchResult(url) {
  if (!requireNickname()) return;
  setTemplateSearchStatus("선택한 템플릿으로 방을 여는 중입니다...");
  await createRoomFromLink(url, { statusTarget: "search" });
}

async function searchTemplates(query) {
  const term = query.trim();
  setTemplateSearchStatus(term ? `${term} 템플릿을 찾는 중입니다...` : "검색어를 입력해주세요.");
  if (!term) return;

  els.templatePreview.hidden = true;
  els.templatePreview.innerHTML = "";
  els.templateSearchResults.innerHTML = "";

  try {
    const params = new URLSearchParams();
    params.set("q", term);
    const response = await fetch(`/api/templates/search?${params.toString()}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "검색에 실패했습니다.");
    renderTemplateResults(data.templates || []);
    setTemplateSearchStatus(
      data.templates?.length
        ? `${data.templates.length}개의 템플릿을 찾았습니다.`
        : "검색 결과가 없습니다. 다른 단어로 다시 찾아보세요."
    );
  } catch (error) {
    setTemplateSearchStatus(error.message, true);
  }
}

function renderTemplateResults(templates) {
  if (!templates.length) {
    els.templateSearchResults.innerHTML = "";
    return;
  }

  els.templateSearchResults.innerHTML = templates
    .map(
      (template) => `
        <article class="template-card">
          <strong title="${escapeHtml(template.title)}">${escapeHtml(template.title)}</strong>
          <span class="room-meta">${escapeHtml(compactTemplateUrl(template.url))}</span>
          <div class="template-actions">
            <button
              type="button"
              class="button button-accent"
              data-import-template-result="${escapeHtml(template.url)}"
            >
              바로 방 만들기
            </button>
            <button
              type="button"
              class="button button-ghost"
              data-preview-template="${escapeHtml(template.url)}"
              data-template-title="${escapeHtml(template.title)}"
            >
              미리보기
            </button>
            <a class="button button-ghost" href="${escapeHtml(template.url)}" target="_blank" rel="noreferrer">
              원본 열기
            </a>
          </div>
        </article>
      `
    )
    .join("");

  els.templateSearchResults.querySelectorAll("[data-preview-template]").forEach((button) => {
    button.addEventListener("click", async () => {
      await previewTemplate(button.dataset.previewTemplate, button.dataset.templateTitle);
    });
  });
  els.templateSearchResults.querySelectorAll("[data-import-template-result]").forEach((button) => {
    button.addEventListener("click", async () => {
      await createRoomFromSearchResult(button.dataset.importTemplateResult);
    });
  });
}

async function previewTemplate(url, fallbackTitle = "TierMaker Template") {
  setTemplateSearchStatus("선택한 템플릿을 미리 불러오는 중입니다...");
  els.templatePreview.hidden = false;
  els.templatePreview.innerHTML = `<div class="template-preview-loading">미리보기 로딩 중</div>`;

  try {
    const response = await fetch(`/api/templates/preview?url=${encodeURIComponent(url)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "미리보기에 실패했습니다.");
    renderTemplatePreview(data.template);
    setTemplateSearchStatus("미리보기를 확인한 뒤 방을 만들 수 있습니다.");
  } catch (error) {
    renderTemplateFallbackPreview({
      title: fallbackTitle,
      sourceUrl: url,
      message: error.message,
    });
    setTemplateSearchStatus("자동 미리보기가 막혔습니다. 원본 사이트를 열어 확인할 수 있습니다.", true);
  }
}

function renderTemplatePreview(template) {
  const tiers = template.tiers || [];
  const items = template.items || [];
  els.templatePreview.hidden = false;
  els.templatePreview.innerHTML = `
    <article class="template-preview-card">
      <div class="template-preview-head">
        <strong title="${escapeHtml(template.title)}">${escapeHtml(template.title)}</strong>
        <span class="room-meta">이미지 ${template.imageCount}개 · 티어 ${template.tierCount}줄</span>
      </div>
      <div class="template-thumb-grid" aria-label="템플릿 이미지 미리보기">
        ${items
          .map(
            (item) => `
              <span class="template-thumb">
                <img src="${getItemImageSrc(item)}" alt="${escapeHtml(item.alt)}" loading="lazy" />
              </span>
            `
          )
          .join("")}
      </div>
      <div class="template-tier-preview" aria-label="템플릿 티어 줄">
        ${tiers
          .map(
            (tier) => `
              <span style="--tier-color:${escapeHtml(tier.color)}">${escapeHtml(tier.label)}</span>
            `
          )
          .join("")}
      </div>
      <div class="template-actions">
        <button type="button" class="button button-accent" data-import-template="${escapeHtml(template.sourceUrl)}">
          이 템플릿으로 방 만들기
        </button>
        <a class="button button-ghost" href="${escapeHtml(template.sourceUrl)}" target="_blank" rel="noreferrer">
          원본 사이트 열기
        </a>
      </div>
    </article>
  `;

  const importButton = els.templatePreview.querySelector("[data-import-template]");
  importButton.addEventListener("click", async () => {
    await createRoomFromSearchResult(importButton.dataset.importTemplate);
  });
}

function renderTemplateFallbackPreview(template) {
  els.templatePreview.hidden = false;
  els.templatePreview.innerHTML = `
    <article class="template-preview-card">
      <div class="template-preview-head">
        <strong title="${escapeHtml(template.title)}">${escapeHtml(template.title)}</strong>
        <span class="room-meta">${escapeHtml(compactTemplateUrl(template.sourceUrl))}</span>
      </div>
      <p class="template-preview-note">${escapeHtml(template.message || "미리보기 정보를 읽지 못했습니다.")}</p>
      <div class="template-actions">
        <button type="button" class="button button-accent" data-import-template="${escapeHtml(template.sourceUrl)}">
          이 링크로 가져오기 시도
        </button>
        <a class="button button-ghost" href="${escapeHtml(template.sourceUrl)}" target="_blank" rel="noreferrer">
          원본 사이트 열기
        </a>
      </div>
    </article>
  `;

  const importButton = els.templatePreview.querySelector("[data-import-template]");
  importButton.addEventListener("click", async () => {
    await createRoomFromSearchResult(importButton.dataset.importTemplate);
  });
}

function setTemplateSearchStatus(message, isError = false) {
  els.templateSearchStatus.textContent = message;
  els.templateSearchStatus.style.color = isError ? "var(--danger)" : "var(--fg-muted)";
}

function compactTemplateUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/^\/create\//, "");
  } catch (_error) {
    return url;
  }
}

function handleTemplateImportFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const templateUrl = params.get("templateUrl") || params.get("importUrl") || "";
  if (!templateUrl) return;

  state.pendingTemplateUrl = templateUrl;
  els.tierUrlInput.value = templateUrl;
  setTemplateSearchStatus("원본 사이트에서 선택한 템플릿 링크를 받았습니다.");

  if (state.nickname) {
    consumePendingTemplateUrl();
  } else {
    setImportStatus("닉네임을 저장하면 선택한 템플릿으로 방을 만듭니다.");
  }
}

async function consumePendingTemplateUrl() {
  const templateUrl = state.pendingTemplateUrl;
  if (!templateUrl) return;
  state.pendingTemplateUrl = "";
  clearTemplateImportQuery();
  await createRoomFromLink(templateUrl);
}

function clearTemplateImportQuery() {
  const url = new URL(window.location.href);
  url.searchParams.delete("templateUrl");
  url.searchParams.delete("importUrl");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function joinRoomFromHash() {
  const roomId = getRoomIdFromHash();
  state.pendingRoomId = roomId || "";
  applyScreenMode();
  if (roomId && state.nickname && (!state.currentRoom || state.currentRoom.id !== roomId)) {
    joinRoom(roomId);
  } else {
    renderWorkspace();
  }
}

function joinRoom(roomId) {
  state.pendingRoomId = roomId;
  state.roomError = "";
  if (!requireNickname()) return;
  window.history.replaceState(null, "", `#room=${encodeURIComponent(roomId)}`);
  applyScreenMode();
  socket.emit("room:join", { roomId, nickname: state.nickname });
}

function leaveRoomToHome() {
  const hadRoom = Boolean(state.currentRoom || state.pendingRoomId || getRoomIdFromHash());
  if (hadRoom) {
    socket.emit("room:leave");
  }
  returnToHome(hadRoom ? "메인 화면으로 돌아왔습니다." : "메인 화면입니다.");
}

function returnToHome(message) {
  state.currentRoom = null;
  state.pendingRoomId = "";
  state.roomError = "";
  state.activeItems = {};
  state.cursors.clear();
  els.cursorLayer.innerHTML = "";
  els.copyStatus.textContent = "";
  window.history.replaceState(null, "", window.location.pathname);
  applyScreenMode();
  renderWorkspace();
  loadRooms();
  setImportStatus(message);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function requireNickname() {
  state.nickname = els.nicknameInput.value.trim().slice(0, 18);
  if (!state.nickname) {
    setImportStatus("먼저 닉네임을 저장해주세요.", true);
    setTemplateSearchStatus("먼저 닉네임을 저장해주세요.", true);
    els.nicknameInput.focus();
    return false;
  }
  localStorage.setItem("mtm:nickname", state.nickname);
  setProfileEnabled();
  return true;
}

function setProfileEnabled() {
  const hasNickname = Boolean(state.nickname);
  els.createRoomForm.querySelectorAll("button, textarea").forEach((control) => {
    control.disabled = !hasNickname;
  });
}

function setImportStatus(message, isError = false) {
  els.importStatus.textContent = message;
  els.importStatus.style.color = isError ? "var(--danger)" : "var(--fg-muted)";
}

function getRoomIdFromHash() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return params.get("room") || "";
}

function applyScreenMode() {
  const isRoomRoute = Boolean(state.currentRoom || state.pendingRoomId || getRoomIdFromHash());
  document.body.classList.toggle("room-mode", isRoomRoute);
}

function renderRooms() {
  if (!state.rooms.length) {
    els.roomList.innerHTML = `<div class="room-card room-card-empty"><strong>열린 방 없음</strong><span class="room-meta">링크로 새 방을 열어보세요</span></div>`;
    return;
  }

  els.roomList.innerHTML = state.rooms
    .map(
      (room) => `
        <article class="room-card">
          <div class="room-card-main">
            <strong title="${escapeHtml(room.title)}">${escapeHtml(room.title)}</strong>
            <div class="room-meta">${room.id} · ${room.playerCount}명 · 이미지 ${room.imageCount}</div>
            ${renderRoomParticipants(room.players || [], "room-card-participants")}
          </div>
          <div class="room-card-actions">
            <button type="button" class="button button-ghost" data-join-room="${room.id}">입장</button>
            <button type="button" class="button button-danger" data-delete-room="${room.id}">삭제</button>
          </div>
        </article>
      `
    )
    .join("");

  els.roomList.querySelectorAll("[data-join-room]").forEach((button) => {
    button.addEventListener("click", () => joinRoom(button.dataset.joinRoom));
  });
  els.roomList.querySelectorAll("[data-delete-room]").forEach((button) => {
    button.addEventListener("click", () => deleteRoom(button.dataset.deleteRoom));
  });
}

function renderWorkspace() {
  const room = state.currentRoom;
  const roomIdFromHash = getRoomIdFromHash();
  const pendingRoomId = state.pendingRoomId || roomIdFromHash;
  const hasRoom = Boolean(room);
  applyScreenMode();
  els.emptyState.hidden = hasRoom;
  els.boardWrap.hidden = !hasRoom;
  els.playerList.hidden = !hasRoom;
  els.addImageButton.disabled = !hasRoom;
  els.addTierButton.disabled = !hasRoom;
  els.saveImageButton.disabled = !hasRoom;
  els.copyRoomButton.disabled = !hasRoom;
  els.resetRoomButton.disabled = !hasRoom;
  els.deleteRoomButton.disabled = !hasRoom;

  if (!room) {
    els.roomCodeLabel.textContent = pendingRoomId ? `ROOM ${pendingRoomId}` : "NO ROOM";
    els.workspaceTitle.textContent = pendingRoomId
      ? "닉네임을 저장하면 바로 입장합니다"
      : "방을 선택하거나 새로 만드세요";
    els.emptyStateText.textContent = state.roomError
      ? state.roomError
        : pendingRoomId
          ? "초대 링크로 들어왔습니다. 상단에서 닉네임을 입력하고 저장하면 이 방으로 바로 입장합니다."
        : "왼쪽에서 닉네임을 정하고, 템플릿을 검색해 고르거나 열린 방에 들어가 같이 정렬을 시작하세요.";
    els.tierBoard.innerHTML = "";
    els.playerList.innerHTML = "";
    renderPlayers();
    return;
  }

  els.roomCodeLabel.textContent = `ROOM ${room.id}`;
  els.workspaceTitle.textContent = room.title;
  renderBoard(room);
  renderPlayers();
}

function renderBoard(room) {
  const lanes = [
    { id: "pool", label: "대기 이미지", color: "var(--bg-elevated)", kind: "pool" },
    ...room.tiers.map((tier) => ({ ...tier, kind: "tier" })),
  ];

  els.tierBoard.innerHTML = lanes
    .map((lane) => {
      const items = room.items
        .filter((item) => item.laneId === lane.id)
        .sort((a, b) => a.order - b.order);
      const tierDragAttrs =
        lane.kind === "tier"
          ? ` draggable="true" data-tier-drag-handle data-tier-id="${escapeHtml(lane.id)}" aria-label="${escapeHtml(lane.label)} 순서 이동"`
          : "";
      const tierHandleIcon = lane.kind === "tier" ? `<span class="tier-drag-icon" aria-hidden="true">↕</span>` : "";
      return `
        <section class="${lane.kind === "pool" ? "pool-row" : "tier-row"}" data-lane-id="${lane.id}">
          <div class="tier-label-cell" style="--tier-color: ${lane.color}"${tierDragAttrs}>
            ${tierHandleIcon}
            <strong>${escapeHtml(lane.label)}</strong>
          </div>
          <div class="drop-zone" data-drop-zone="${lane.id}" aria-label="${escapeHtml(lane.label)} 영역">
            ${items.map(renderItem).join("")}
          </div>
        </section>
      `;
    })
    .join("");

  els.tierBoard.querySelectorAll(".tier-item").forEach(bindItemEvents);
  els.tierBoard.querySelectorAll(".drop-zone").forEach(bindDropZoneEvents);
  els.tierBoard.querySelectorAll("[data-tier-drag-handle]").forEach(bindTierDragEvents);
  bindTierBoardReorderEvents();
}

function renderItem(item) {
  const imageSrc = getItemImageSrc(item);
  const displayName = getItemDisplayName(item);
  const active = getItemActiveFocus(item.id);
  const activeStyle = active ? ` style="--active-color:${escapeHtml(active.color)}"` : "";
  const activeBadge = active
    ? `<span class="active-owner" title="${escapeHtml(active.nickname)}">${escapeHtml(active.nickname)}</span>`
    : "";
  return `
    <div class="tier-item${active ? " is-active" : ""}" draggable="true" data-item-id="${item.id}" aria-label="${escapeHtml(displayName)}"${activeStyle}>
      <img src="${imageSrc}" alt="${escapeHtml(displayName)}" loading="lazy" />
      ${activeBadge}
    </div>
  `;
}

function getItemImageSrc(item) {
  return item.src.startsWith("data:")
    ? item.src
    : `/api/image?url=${encodeURIComponent(item.src)}`;
}

function bindItemEvents(item) {
  item.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    setActiveItem(item.dataset.itemId);
  });
  item.addEventListener("dblclick", () => {
    openImagePreview(item.dataset.itemId);
  });
  item.addEventListener("dragstart", (event) => {
    event.stopPropagation();
    state.draggedItemId = item.dataset.itemId;
    setActiveItem(item.dataset.itemId);
    item.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", item.dataset.itemId);
  });
  item.addEventListener("dragend", () => {
    state.draggedItemId = null;
    item.classList.remove("is-dragging");
  });
}

function bindDropZoneEvents(zone) {
  zone.addEventListener("dragover", (event) => {
    if (state.draggedTierId) return;
    event.preventDefault();
    zone.classList.add("is-over");
  });
  zone.addEventListener("dragleave", () => {
    zone.classList.remove("is-over");
  });
  zone.addEventListener("drop", (event) => {
    if (state.draggedTierId) return;
    event.preventDefault();
    zone.classList.remove("is-over");
    const itemId = event.dataTransfer.getData("text/plain") || state.draggedItemId;
    if (!itemId) return;
    const beforeElement = getBeforeElement(zone, event.clientX, event.clientY);
    socket.emit("item:move", {
      itemId,
      laneId: zone.dataset.dropZone,
      beforeId: beforeElement?.dataset.itemId || null,
    });
  });
}

function bindTierDragEvents(handle) {
  handle.addEventListener("dragstart", (event) => {
    const tierId = handle.dataset.tierId;
    if (!tierId) return;
    state.draggedTierId = tierId;
    const row = handle.closest(".tier-row");
    row?.classList.add("is-tier-dragging");
    els.tierBoard.classList.add("is-tier-reordering");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-mtm-tier", tierId);
    event.dataTransfer.setData("text/plain", tierId);
  });

  handle.addEventListener("dragend", () => {
    clearTierDropMarkers();
    state.draggedTierId = null;
    els.tierBoard.classList.remove("is-tier-reordering", "is-tier-drop-end");
    handle.closest(".tier-row")?.classList.remove("is-tier-dragging");
  });
}

function bindTierBoardReorderEvents() {
  if (els.tierBoard.dataset.tierReorderBound) return;
  els.tierBoard.dataset.tierReorderBound = "true";

  els.tierBoard.addEventListener("dragover", (event) => {
    if (!state.draggedTierId) return;
    event.preventDefault();
    const beforeRow = getBeforeTierRow(event.clientY);
    clearTierDropMarkers();
    if (beforeRow) {
      beforeRow.classList.add("is-tier-drop-before");
    } else {
      els.tierBoard.classList.add("is-tier-drop-end");
    }
  });

  els.tierBoard.addEventListener("drop", (event) => {
    if (!state.draggedTierId) return;
    event.preventDefault();
    const beforeRow = getBeforeTierRow(event.clientY);
    socket.emit("tier:move", {
      tierId: state.draggedTierId,
      beforeId: beforeRow?.dataset.laneId || null,
    });
    clearTierDropMarkers();
    els.tierBoard.classList.remove("is-tier-drop-end");
  });
}

function getBeforeTierRow(y) {
  const rows = [...els.tierBoard.querySelectorAll(".tier-row:not(.is-tier-dragging)")];
  return rows.find((row) => {
    const box = row.getBoundingClientRect();
    return y < box.top + box.height / 2;
  }) || null;
}

function clearTierDropMarkers() {
  els.tierBoard.querySelectorAll(".is-tier-drop-before").forEach((row) => {
    row.classList.remove("is-tier-drop-before");
  });
}

function getBeforeElement(zone, x, y) {
  const candidates = [...zone.querySelectorAll(".tier-item:not(.is-dragging)")];
  return candidates.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const verticalOffset = y - box.top - box.height / 2;
      const horizontalOffset = x - box.left - box.width / 2;
      const offset = Math.abs(verticalOffset) > box.height ? verticalOffset : horizontalOffset;
      if (offset < 0 && offset > closest.offset) {
        return { offset, element: child };
      }
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY, element: null }
  ).element;
}

function mapActiveItems(activeItems) {
  return activeItems.reduce((acc, active) => {
    if (active.playerId && active.itemId) {
      acc[active.playerId] = active;
    }
    return acc;
  }, {});
}

function getItemActiveFocus(itemId) {
  return Object.values(state.activeItems).find((active) => active.itemId === itemId) || null;
}

function setActiveItem(itemId) {
  if (!state.currentRoom || !itemId) return;
  const player = state.currentRoom.players.find((entry) => entry.id === socket.id);
  if (player) {
    state.activeItems[socket.id] = {
      itemId,
      playerId: socket.id,
      nickname: player.nickname,
      color: player.color,
    };
    renderItemHighlights();
  }
  socket.emit("item:focus", { itemId });
}

function clearActiveItem() {
  if (!state.currentRoom) return;
  if (state.activeItems[socket.id]) {
    delete state.activeItems[socket.id];
    renderItemHighlights();
  }
  socket.emit("item:focus", { itemId: null });
}

function renderItemHighlights() {
  els.tierBoard.querySelectorAll(".tier-item").forEach((tile) => {
    const active = getItemActiveFocus(tile.dataset.itemId);
    tile.classList.toggle("is-active", Boolean(active));
    tile.style.setProperty("--active-color", active?.color || "transparent");
    tile.querySelector(".active-owner")?.remove();
    if (active) {
      const badge = document.createElement("span");
      badge.className = "active-owner";
      badge.title = active.nickname;
      badge.textContent = active.nickname;
      tile.appendChild(badge);
    }
  });
}

function renderPlayers() {
  const players = state.currentRoom?.players || [];
  els.playerList.hidden = !state.currentRoom;
  if (!players.length) {
    els.playerList.innerHTML = `<div class="room-participants is-empty"><span>참가자 대기 중</span></div>`;
    return;
  }

  els.playerList.innerHTML = renderRoomParticipants(players, "room-participants", true);
}

function renderRoomParticipants(players, className = "room-participants", markSelf = false) {
  if (!players.length) {
    return `<div class="${className} is-empty"><span>참가자 없음</span></div>`;
  }

  return `
    <div class="${className}">
      ${players
        .map((player) => {
          const isSelf = markSelf && player.id === socket.id;
          return `
            <span class="participant-chip" style="--player-color:${escapeHtml(player.color)}" title="${escapeHtml(player.nickname)}">
              <span class="participant-dot"></span>
              <span>${escapeHtml(player.nickname)}${isSelf ? " · 나" : ""}</span>
            </span>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderCursors() {
  const liveCursors = [...state.cursors.entries()].filter(
    ([, value]) => Date.now() - value.cursor.at < 8000
  );
  els.cursorLayer.innerHTML = liveCursors
    .map(([playerId, value]) => {
      const point = cursorToViewport(value.cursor);
      return `
        <div class="remote-cursor" data-cursor-id="${playerId}" style="--cursor-x:${point.x}px; --cursor-y:${point.y}px; --cursor-color:${value.color}">
          <span class="cursor-arrow"></span>
          <span class="cursor-name">${escapeHtml(value.nickname)}</span>
        </div>
      `;
    })
    .join("");
}

function buildCursorPayload(event) {
  const boardRect = els.boardWrap.getBoundingClientRect();
  const isInsideBoard =
    !els.boardWrap.hidden &&
    event.clientX >= boardRect.left &&
    event.clientX <= boardRect.right &&
    event.clientY >= boardRect.top &&
    event.clientY <= boardRect.bottom;

  if (isInsideBoard) {
    return {
      mode: "board",
      x: event.clientX - boardRect.left + els.boardWrap.scrollLeft,
      y: event.clientY - boardRect.top + els.boardWrap.scrollTop,
    };
  }

  return {
    mode: "page",
    x: event.clientX + window.scrollX,
    y: event.clientY + window.scrollY,
  };
}

function cursorToViewport(cursor) {
  if (cursor.mode === "board" && !els.boardWrap.hidden) {
    const boardRect = els.boardWrap.getBoundingClientRect();
    return {
      x: boardRect.left + cursor.x - els.boardWrap.scrollLeft,
      y: boardRect.top + cursor.y - els.boardWrap.scrollTop,
    };
  }

  return {
    x: cursor.x - window.scrollX,
    y: cursor.y - window.scrollY,
  };
}

function openImagePreview(itemId) {
  const item = state.currentRoom?.items.find((entry) => entry.id === itemId);
  if (!item) return;
  const displayName = getItemDisplayName(item);
  els.lightboxImage.src = getItemImageSrc(item);
  els.lightboxImage.alt = displayName;
  els.lightboxTitle.textContent = displayName;
  els.imageLightbox.hidden = false;
  els.closeLightboxButton.focus();
}

function getItemDisplayName(item) {
  const label = String(item?.alt || "").replace(/\s+/g, " ").trim();
  const genericMatch = label.match(/^(?:tier\s*item|티어\s*아이템)\s*(\d+)?$/i);
  if (genericMatch) {
    return genericMatch[1] ? `이미지 ${genericMatch[1]}` : "이미지";
  }
  return label || "이미지";
}

function closeImagePreview() {
  els.imageLightbox.hidden = true;
  els.lightboxImage.removeAttribute("src");
}

async function handleImageUpload(event) {
  const file = event.target.files?.[0];
  if (!file || !state.currentRoom) return;

  if (!file.type.startsWith("image/")) {
    setImportStatus("이미지 파일만 추가할 수 있습니다.", true);
    return;
  }

  const previousText = els.addImageButton.textContent;
  els.addImageButton.disabled = true;
  els.addImageButton.textContent = "추가 중";

  try {
    const dataUrl = await createImageThumbnail(file);
    await addImageItem(dataUrl, file.name.replace(/\.[^.]+$/, ""));
  } catch (error) {
    setImportStatus(`이미지 추가에 실패했습니다: ${error.message}`, true);
  } finally {
    els.addImageButton.textContent = previousText;
    els.addImageButton.disabled = !state.currentRoom;
  }
}

function openTierDialog() {
  if (!state.currentRoom) return;
  els.tierNameInput.value = "";
  els.tierDialogStatus.textContent = "";
  els.tierDialog.hidden = false;
  requestAnimationFrame(() => els.tierNameInput.focus());
}

function closeTierDialog() {
  els.tierDialog.hidden = true;
  els.tierDialogStatus.textContent = "";
}

async function submitTierDialog(event) {
  event.preventDefault();
  if (!state.currentRoom) {
    closeTierDialog();
    return;
  }

  const label = els.tierNameInput.value.trim();
  if (!label) {
    els.tierDialogStatus.textContent = "티어 이름을 입력해주세요.";
    els.tierNameInput.focus();
    return;
  }

  const submitButton = els.tierDialogForm.querySelector('button[type="submit"]');
  const previousText = submitButton.textContent;
  submitButton.disabled = true;
  submitButton.textContent = "추가 중";
  els.tierDialogStatus.textContent = "티어를 추가하는 중입니다.";

  try {
    const response = await emitWithAck("tier:add", { label });
    if (!response.ok) throw new Error(response.message || "티어 추가에 실패했습니다.");
    closeTierDialog();
    setImportStatus(`"${label}" 티어를 추가했습니다.`);
  } catch (error) {
    els.tierDialogStatus.textContent = error.message;
    setImportStatus(`티어 추가에 실패했습니다: ${error.message}`, true);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = previousText;
  }
}

async function addImageItem(src, alt) {
  const response = await emitWithAck("item:add", { src, alt });
  if (!response.ok) throw new Error(response.message || "이미지를 추가하지 못했습니다.");
  setImportStatus(`"${String(alt || "이미지").trim()}" 이미지를 추가했습니다.`);
}

function emitWithAck(eventName, payload) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("서버 응답이 없습니다.")), 6000);
    socket.emit(eventName, payload, (response) => {
      window.clearTimeout(timer);
      resolve(response || { ok: false, message: "응답이 비어 있습니다." });
    });
  });
}

async function createImageThumbnail(file) {
  const imageUrl = URL.createObjectURL(file);
  try {
    const image = await loadDomImage(imageUrl);
    const canvas = document.createElement("canvas");
    canvas.width = 360;
    canvas.height = 360;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#11100f";
    ctx.fillRect(0, 0, 360, 360);
    drawCoverImage(ctx, image, 0, 0, 360, 360);
    return canvas.toDataURL("image/webp", 0.82);
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

function loadDomImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("이미지를 읽지 못했습니다."));
    image.src = src;
  });
}

async function saveBoardImage() {
  if (!state.currentRoom) return;

  const previousText = els.saveImageButton.textContent;
  els.saveImageButton.disabled = true;
  els.saveImageButton.textContent = "저장 중";
  els.copyStatus.textContent = "저장 중";

  try {
    const blob = await renderBoardToPng(state.currentRoom);
    const filename = `multiplay-tier-maker-${state.currentRoom.id}.png`;
    const saveMode = await saveBlobToDownloads(blob, filename);
    els.copyStatus.textContent = "이미지 저장됨";
    setImportStatus(
      saveMode === "picker"
        ? "현재 티어 이미지를 다운로드 폴더에서 저장했습니다."
        : "현재 티어 이미지를 기본 다운로드 폴더로 내려받았습니다."
    );
  } catch (error) {
    els.copyStatus.textContent = "저장 실패";
    setImportStatus(`이미지 저장에 실패했습니다: ${error.message}`, true);
  } finally {
    els.saveImageButton.textContent = previousText;
    els.saveImageButton.disabled = !state.currentRoom;
  }
}

async function saveBlobToDownloads(blob, filename) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        startIn: "downloads",
        types: [
          {
            description: "PNG 이미지",
            accept: { "image/png": [".png"] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return "picker";
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error("저장이 취소되었습니다.");
      }
    }
  }

  triggerBrowserDownload(blob, filename);
  return "download";
}

function triggerBrowserDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function renderBoardToPng(room) {
  const lanes = [
    { id: "pool", label: "대기 이미지", color: "#2b2822" },
    ...room.tiers,
  ];
  const labelWidth = 190;
  const itemSize = 72;
  const gap = 8;
  const padding = 18;
  const titleHeight = 64;
  const maxItems = Math.max(...lanes.map((lane) => room.items.filter((item) => item.laneId === lane.id).length), 1);
  const columns = Math.min(10, Math.max(4, Math.ceil(Math.sqrt(maxItems * 1.8))));
  const contentWidth = columns * itemSize + (columns - 1) * gap + padding * 2;
  const width = labelWidth + contentWidth;

  const laneData = lanes.map((lane) => {
    const items = room.items
      .filter((item) => item.laneId === lane.id)
      .sort((a, b) => a.order - b.order);
    const rows = Math.max(1, Math.ceil(items.length / columns));
    return {
      ...lane,
      items,
      height: Math.max(96, padding * 2 + rows * itemSize + (rows - 1) * gap),
    };
  });

  const height = titleHeight + laneData.reduce((sum, lane) => sum + lane.height + gap, 0) + padding;
  const canvas = document.createElement("canvas");
  canvas.width = width * 2;
  canvas.height = height * 2;
  const ctx = canvas.getContext("2d");
  ctx.scale(2, 2);
  ctx.fillStyle = "#151312";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#f6efe3";
  ctx.font = "700 24px Barlow, Arial, sans-serif";
  ctx.fillText(room.title, padding, 36);
  ctx.fillStyle = "#2dd4bf";
  ctx.font = "700 12px JetBrains Mono, Consolas, monospace";
  ctx.fillText(`ROOM ${room.id}`, padding, 56);

  let y = titleHeight;
  for (const lane of laneData) {
    drawRoundRect(ctx, 0, y, width, lane.height, 8, "#11100f");
    ctx.fillStyle = lane.color || "#64748b";
    ctx.fillRect(0, y, labelWidth, lane.height);
    ctx.fillStyle = lane.id === "pool" ? "#f6efe3" : "#110f0e";
    ctx.font = "700 16px Barlow, Arial, sans-serif";
    wrapCanvasText(ctx, lane.label, padding, y + 34, labelWidth - padding * 2, 19);

    for (let index = 0; index < lane.items.length; index += 1) {
      const item = lane.items[index];
      const image = await loadCanvasImage(getItemImageSrc(item));
      const col = index % columns;
      const row = Math.floor(index / columns);
      const x = labelWidth + padding + col * (itemSize + gap);
      const itemY = y + padding + row * (itemSize + gap);
      ctx.fillStyle = "#211f1b";
      ctx.fillRect(x, itemY, itemSize, itemSize);
      if (image) {
        drawCoverImage(ctx, image, x, itemY, itemSize, itemSize);
      }
    }

    y += lane.height + gap;
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Canvas export failed."));
    }, "image/png");
  });
}

function loadCanvasImage(src) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

function drawCoverImage(ctx, image, x, y, width, height) {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  ctx.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
}

function drawRoundRect(ctx, x, y, width, height, radius, fillStyle) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
  ctx.fillStyle = fillStyle;
  ctx.fill();
}

function wrapCanvasText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = String(text).split(/\s+/);
  let line = "";
  for (const word of words) {
    const testLine = line ? `${line} ${word}` : word;
    if (ctx.measureText(testLine).width > maxWidth && line) {
      ctx.fillText(line, x, y);
      line = word;
      y += lineHeight;
    } else {
      line = testLine;
    }
  }
  if (line) ctx.fillText(line, x, y);
}

async function copyRoomLink() {
  if (!state.currentRoom) return;
  await loadConfig();
  const baseUrl = getShareBaseUrl();
  const link = `${baseUrl}/#room=${state.currentRoom.id}`;
  const isLocalLink = ["localhost", "127.0.0.1"].includes(new URL(baseUrl).hostname);

  try {
    await writeClipboard(link);
    els.copyStatus.textContent = isLocalLink ? "로컬 링크 복사됨" : "초대 링크 복사됨";
    setImportStatus(
      isLocalLink
        ? `로컬 초대 링크를 복사했습니다: ${link}`
        : `초대 링크를 클립보드에 복사했습니다: ${link}`
    );
  } catch (_error) {
    els.copyStatus.textContent = "복사 실패";
    setImportStatus(`복사가 막혔습니다. 이 링크를 직접 복사해주세요: ${link}`, true);
  }
}

async function deleteRoom(roomId) {
  if (!roomId) return;

  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`, {
      method: "DELETE",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || "방 삭제에 실패했습니다.");

    if (state.currentRoom?.id === roomId || state.pendingRoomId === roomId || getRoomIdFromHash() === roomId) {
      returnToHome("방을 삭제했습니다.");
    } else {
      setImportStatus("방을 삭제했습니다.");
      loadRooms();
    }
  } catch (error) {
    setImportStatus(error.message, true);
  }
}

function getShareBaseUrl() {
  return state.publicBaseUrl || window.location.origin;
}

async function writeClipboard(text) {
  if (copyWithSelection(text)) {
    return;
  }

  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  throw new Error("Copy command failed.");
}

function copyWithSelection(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "0";
  textarea.style.top = "0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
