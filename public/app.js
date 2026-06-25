const socket = io();

const MIN_BOARD_ZOOM = 0.65;
const MAX_BOARD_ZOOM = 1.15;
const BOARD_ZOOM_STEP = 0.1;
const ITEM_LOCK_TTL_MS = 30_000;
const HOST_TOKEN_KEY_PREFIX = "mtm:hostToken:";
const ROOM_MODE_TIERMAKER = "tiermaker";
const ROOM_MODE_WORLDCUP = "worldcup";
const WORLDCUP_BRACKET_SIZES = [4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];

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
  selectedItemId: null,
  boardZoom: readStoredBoardZoom(),
  gameMode: normalizeGameMode(localStorage.getItem("mtm:gameMode")),
  isCreatingRoom: false,
  roomCreateProgress: 0,
  roomCreateStartedAt: 0,
  roomCreateTimer: null,
  roomCreateHideTimer: null,
  roomStatusHideTimer: null,
  pendingConfirmAction: null,
};

const els = {
  homeButton: document.querySelector("#homeButton"),
  nicknameInput: document.querySelector("#nicknameInput"),
  profileForm: document.querySelector("#profileForm"),
  connectionStatus: document.querySelector("#connectionStatus"),
  createTabButtons: document.querySelectorAll("[data-create-tab]"),
  createTabPanels: document.querySelectorAll(".create-tab-panel"),
  createRoomForm: document.querySelector("#createRoomForm"),
  gameModeInputs: document.querySelectorAll('input[name="gameMode"]'),
  sourceUrlLabel: document.querySelector("#sourceUrlLabel"),
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
  toolbarActions: document.querySelector("#toolbarActions"),
  copyStatus: document.querySelector("#copyStatus"),
  roomStatusToast: document.querySelector("#roomStatusToast"),
  roomStatusText: document.querySelector("#roomStatusText"),
  closeRoomStatusButton: document.querySelector("#closeRoomStatusButton"),
  addImageButton: document.querySelector("#addImageButton"),
  addTierButton: document.querySelector("#addTierButton"),
  zoomControl: document.querySelector(".zoom-control"),
  zoomOutButton: document.querySelector("#zoomOutButton"),
  zoomInButton: document.querySelector("#zoomInButton"),
  zoomLevelLabel: document.querySelector("#zoomLevelLabel"),
  imageUploadInput: document.querySelector("#imageUploadInput"),
  saveImageButton: document.querySelector("#saveImageButton"),
  copyRoomButton: document.querySelector("#copyRoomButton"),
  resetRoomButton: document.querySelector("#resetRoomButton"),
  deleteRoomButton: document.querySelector("#deleteRoomButton"),
  emptyState: document.querySelector("#emptyState"),
  emptyStateText: document.querySelector("#emptyStateText"),
  boardWrap: document.querySelector("#boardWrap"),
  tierBoard: document.querySelector("#tierBoard"),
  worldcupBoard: document.querySelector("#worldcupBoard"),
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
  confirmDialog: document.querySelector("#confirmDialog"),
  confirmDialogTitle: document.querySelector("#confirmDialogTitle"),
  confirmDialogMessage: document.querySelector("#confirmDialogMessage"),
  closeConfirmDialogButton: document.querySelector("#closeConfirmDialogButton"),
  closeConfirmDialogBackdrop: document.querySelector("#closeConfirmDialogBackdrop"),
  cancelConfirmDialogButton: document.querySelector("#cancelConfirmDialogButton"),
  acceptConfirmDialogButton: document.querySelector("#acceptConfirmDialogButton"),
  roomCreateProgress: document.querySelector("#roomCreateProgress"),
  roomCreateProgressTitle: document.querySelector("#roomCreateProgressTitle"),
  roomCreateProgressText: document.querySelector("#roomCreateProgressText"),
  roomCreateProgressBar: document.querySelector("#roomCreateProgressBar"),
  roomCreateProgressPercent: document.querySelector("#roomCreateProgressPercent"),
  roomCreateProgressElapsed: document.querySelector("#roomCreateProgressElapsed"),
};

function icon(name) {
  return `<i data-lucide="${escapeHtml(name)}" aria-hidden="true"></i>`;
}

function buttonContent(iconName, label) {
  return `${icon(iconName)}${escapeHtml(label)}`;
}

function hydrateIcons() {
  if (!window.lucide?.createIcons) return;
  window.lucide.createIcons({
    attrs: {
      "aria-hidden": "true",
      focusable: "false",
      "stroke-width": "2.25",
    },
  });
}

els.nicknameInput.value = state.nickname;
setProfileEnabled();
applyBoardZoom();
applyGameModeUI();
setCreateTab("search");
hydrateIcons();
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
  const wasTieBreaking = Boolean(state.currentRoom?.worldcup?.tieBreak);
  state.currentRoom = room;
  state.pendingRoomId = "";
  state.roomError = "";
  state.activeItems = mapActiveItems(room.activeItems || []);
  state.cursors.clear();
  if (normalizeGameMode(room.mode) === ROOM_MODE_WORLDCUP) {
    if (room.worldcup?.tieBreak) {
      els.copyStatus.textContent = "동률 판정 중";
    } else if (wasTieBreaking) {
      els.copyStatus.textContent = "다음 대결";
    }
  }
  renderWorkspace();
});

socket.on("room:error", ({ message }) => {
  state.currentRoom = null;
  state.roomError = message;
  state.selectedItemId = null;
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

socket.on("item:blocked", ({ nickname }) => {
  clearSelectedItem();
  els.copyStatus.textContent = "사용 중";
  setImportStatus(`${nickname || "다른 참가자"}님이 잡고 있는 이미지는 이동할 수 없습니다.`, true);
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
els.createTabButtons.forEach((button) => {
  button.addEventListener("click", () => setCreateTab(button.dataset.createTab));
  button.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(els.createTabButtons);
    const currentIndex = buttons.indexOf(button);
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const nextButton = buttons[(currentIndex + direction + buttons.length) % buttons.length];
    setCreateTab(nextButton.dataset.createTab);
    nextButton.focus();
  });
});
els.gameModeInputs.forEach((input) => {
  input.addEventListener("change", () => {
    if (!input.checked) return;
    state.gameMode = normalizeGameMode(input.value);
    localStorage.setItem("mtm:gameMode", state.gameMode);
    applyGameModeUI();
  });
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
els.zoomOutButton.addEventListener("click", () => changeBoardZoom(-BOARD_ZOOM_STEP));
els.zoomInButton.addEventListener("click", () => changeBoardZoom(BOARD_ZOOM_STEP));
els.saveImageButton.addEventListener("click", saveBoardImage);
els.copyRoomButton.addEventListener("click", copyRoomLink);
els.closeRoomStatusButton.addEventListener("click", hideRoomStatus);
els.resetRoomButton.addEventListener("click", confirmResetRoom);
els.deleteRoomButton.addEventListener("click", () => {
  const roomId = state.currentRoom?.id;
  if (roomId) confirmDeleteRoom(roomId);
});
els.closeLightboxButton.addEventListener("click", closeImagePreview);
els.closeLightboxBackdrop.addEventListener("click", () => {
  closeImagePreview();
  clearActiveItem();
});
els.cancelTierDialogButton.addEventListener("click", closeTierDialog);
els.closeTierDialogBackdrop.addEventListener("click", closeTierDialog);
els.tierDialogForm.addEventListener("submit", submitTierDialog);
els.closeConfirmDialogButton.addEventListener("click", closeConfirmDialog);
els.closeConfirmDialogBackdrop.addEventListener("click", closeConfirmDialog);
els.cancelConfirmDialogButton.addEventListener("click", closeConfirmDialog);
els.acceptConfirmDialogButton.addEventListener("click", acceptConfirmDialog);

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
window.setInterval(pruneLocalActiveItems, 5000);
document.addEventListener("pointerdown", (event) => {
  if (!state.currentRoom) return;
  if (
    event.target.closest(".tier-item") ||
    event.target.closest(".drop-zone") ||
    event.target.closest(".tier-label-cell") ||
    event.target.closest(".image-lightbox") ||
    event.target.closest(".confirm-dialog")
  ) {
    return;
  }
  clearSelectedItem();
  clearActiveItem();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.confirmDialog.hidden) {
    closeConfirmDialog();
  } else if (event.key === "Escape" && !els.imageLightbox.hidden) {
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
  if (state.isCreatingRoom) {
    const status = options.statusTarget === "search" ? setTemplateSearchStatus : setImportStatus;
    status("이미 방을 생성하는 중입니다. 잠시만 기다려주세요.");
    return;
  }

  const mode = normalizeGameMode(options.mode || inferGameModeFromUrl(url) || state.gameMode);
  const bracketSize = normalizeWorldcupBracketSize(options.bracketSize);
  const status = options.statusTarget === "search" ? setTemplateSearchStatus : setImportStatus;
  const progressLabel = getRoomCreationProgressLabel(mode, bracketSize);
  status(`${progressLabel}을 여는 중입니다...`);
  startRoomCreateProgress(progressLabel);

  try {
    const response = await fetch("/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, mode, bracketSize }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "가져오기에 실패했습니다.");
    const roomLabel = getRoomBracketLabel(data.room);
    status(
      data.existing
        ? `이미 열린 ${roomLabel}입니다. 기존 방으로 입장합니다.`
        : `${roomLabel}이 열렸습니다. 바로 입장합니다.`
    );
    if (data.hostToken) {
      saveHostToken(data.room.id, data.hostToken);
    }
    joinRoom(data.room.id);
    completeRoomCreateProgress(`${roomLabel} 준비 완료`);
  } catch (error) {
    status(error.message, true);
    failRoomCreateProgress(error.message);
  }
}

async function createRoomFromSearchResult(url, options = {}) {
  if (!requireNickname()) return;
  setTemplateSearchStatus("선택한 항목으로 방을 여는 중입니다...");
  await createRoomFromLink(url, { statusTarget: "search", mode: state.gameMode, bracketSize: options.bracketSize });
}

async function searchTemplates(query) {
  const term = query.trim();
  setTemplateSearchStatus(term ? `${term} ${getModeLabel(state.gameMode)} 결과를 찾는 중입니다...` : "검색어를 입력해주세요.");
  if (!term) return;

  els.templatePreview.hidden = true;
  els.templatePreview.innerHTML = "";
  els.templateSearchResults.innerHTML = "";

  try {
    const params = new URLSearchParams();
    params.set("q", term);
    params.set("mode", state.gameMode);
    const response = await fetch(`/api/templates/search?${params.toString()}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "검색에 실패했습니다.");
    renderTemplateResults(data.templates || []);
    setTemplateSearchStatus(
      data.templates?.length
        ? `${data.templates.length}개의 ${getModeLabel(state.gameMode)} 결과를 찾았습니다.`
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

  const isWorldcup = state.gameMode === ROOM_MODE_WORLDCUP;
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
              ${buttonContent(isWorldcup ? "trophy" : "plus-circle", isWorldcup ? "규모 선택" : "바로 방 만들기")}
            </button>
            <button
              type="button"
              class="button button-ghost"
              data-preview-template="${escapeHtml(template.url)}"
              data-template-title="${escapeHtml(template.title)}"
            >
              ${buttonContent("eye", "미리보기")}
            </button>
            <a class="button button-ghost" href="${escapeHtml(template.url)}" target="_blank" rel="noreferrer">
              ${buttonContent("external-link", "원본 열기")}
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
      if (state.gameMode === ROOM_MODE_WORLDCUP) {
        await previewTemplate(button.dataset.importTemplateResult, button.closest(".template-card")?.querySelector("strong")?.textContent || "PIKU 이상형월드컵");
        return;
      }
      await createRoomFromSearchResult(button.dataset.importTemplateResult);
    });
  });
  hydrateIcons();
}

async function previewTemplate(url, fallbackTitle = "Template") {
  setTemplateSearchStatus("선택한 항목을 미리 불러오는 중입니다...");
  els.templatePreview.hidden = false;
  els.templatePreview.innerHTML = `<div class="template-preview-loading">${icon("loader-circle")}미리보기 로딩 중</div>`;
  hydrateIcons();

  try {
    const params = new URLSearchParams({ url, mode: state.gameMode });
    const response = await fetch(`/api/templates/preview?${params.toString()}`);
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
  const isWorldcup = normalizeGameMode(template.mode || state.gameMode) === ROOM_MODE_WORLDCUP;
  els.templatePreview.hidden = false;
  els.templatePreview.innerHTML = `
    <article class="template-preview-card">
      <div class="template-preview-head">
        <strong title="${escapeHtml(template.title)}">${escapeHtml(template.title)}</strong>
        <span class="room-meta">${escapeHtml(getPreviewMeta(template))}</span>
      </div>
      ${isWorldcup ? "" : `<div class="template-thumb-grid" aria-label="템플릿 이미지 미리보기">
        ${items
          .map(
            (item) => `
              <span class="template-thumb">
                <img src="${getItemImageSrc(item)}" alt="${escapeHtml(item.alt)}" loading="lazy"${getItemFallbackImageSrc(item) ? ` data-fallback-src="${escapeHtml(getItemFallbackImageSrc(item))}" referrerpolicy="no-referrer"` : ""} />
              </span>
            `
          )
          .join("")}
      </div>`}
      ${isWorldcup ? renderWorldcupBracketPicker(template) : ""}
      ${tiers.length ? `<div class="template-tier-preview" aria-label="템플릿 티어 줄">
        ${tiers
          .map(
            (tier) => `
              <span style="--tier-color:${escapeHtml(tier.color)}">${escapeHtml(tier.label)}</span>
            `
          )
          .join("")}
      </div>` : ""}
      <div class="template-actions">
        <button type="button" class="button button-accent" data-import-template="${escapeHtml(template.sourceUrl)}">
          ${buttonContent(isWorldcup ? "trophy" : "plus-circle", isWorldcup ? "선택한 규모로 방 만들기" : "이 항목으로 방 만들기")}
        </button>
        <a class="button button-ghost" href="${escapeHtml(template.sourceUrl)}" target="_blank" rel="noreferrer">
          ${buttonContent("external-link", "원본 사이트 열기")}
        </a>
      </div>
    </article>
  `;

  const importButton = els.templatePreview.querySelector("[data-import-template]");
  els.templatePreview.querySelectorAll("img").forEach((image) => {
    image.addEventListener("error", () => fallbackItemImage(image), { once: true });
  });
  importButton.addEventListener("click", async () => {
    const bracketSize = normalizeWorldcupBracketSize(
      els.templatePreview.querySelector("[data-worldcup-bracket-select]")?.value
    );
    await createRoomFromSearchResult(importButton.dataset.importTemplate, { bracketSize });
  });
  hydrateIcons();
}

function renderWorldcupBracketPicker(template) {
  const options = getAvailableWorldcupBracketOptions(template);
  if (!options.length) return "";
  const importableOptions = options.filter((option) => option.importable);
  const templateSize = normalizeWorldcupBracketSize(template.bracketSize || template.defaultBracketSize);
  const selected =
    Number(importableOptions.at(-1)?.size || 0) ||
    (templateSize && options.some((option) => option.size === templateSize) ? templateSize : 0) ||
    Number(options.at(-1)?.size || 0);
  return `
    <label class="template-bracket-picker">
      <span>월드컵 규모</span>
      <select data-worldcup-bracket-select>
        ${options
          .map(
            (option) => `
              <option value="${option.size}"${option.size === selected ? " selected" : ""}${option.importable ? "" : " disabled"}>
                ${option.size}강${option.importable ? "" : " (후보 부족)"}
              </option>
            `
          )
          .join("")}
      </select>
    </label>
  `;
}

function getAvailableWorldcupBracketOptions(template) {
  const options = Array.isArray(template.bracketOptions) ? template.bracketOptions : [];
  const enabled = options
    .filter((option) => option.enabled)
    .map((option) => ({
      size: normalizeWorldcupBracketSize(option.size),
      importable: option.importable !== false,
    }))
    .filter((option) => option.size);
  if (enabled.length) return enabled;

  const count = Number(template.imageCount || template.bracketSize || 0);
  return WORLDCUP_BRACKET_SIZES.filter((size) => size <= count).map((size) => ({ size }));
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
          ${buttonContent("plus-circle", "이 링크로 방 만들기")}
        </button>
        <a class="button button-ghost" href="${escapeHtml(template.sourceUrl)}" target="_blank" rel="noreferrer">
          ${buttonContent("external-link", "원본 사이트 열기")}
        </a>
      </div>
    </article>
  `;

  const importButton = els.templatePreview.querySelector("[data-import-template]");
  importButton.addEventListener("click", async () => {
    await createRoomFromSearchResult(importButton.dataset.importTemplate);
  });
  hydrateIcons();
}

function setTemplateSearchStatus(message, isError = false) {
  els.templateSearchStatus.textContent = message;
  els.templateSearchStatus.style.color = isError ? "var(--danger)" : "var(--fg-muted)";
}

function getPreviewMeta(template) {
  const mode = normalizeGameMode(template?.mode || state.gameMode);
  if (mode === ROOM_MODE_WORLDCUP) {
    const available = Number(template.availableItemCount || template.previewItemCount || 0);
    const maxOption = Math.max(
      0,
      ...(template.bracketOptions || [])
        .filter((option) => option.enabled)
        .map((option) => Number(option.size || 0))
    );
    return `${maxOption ? `${maxOption}강까지 표시` : "규모 선택"} · 자동 확보 후보 ${available}개`;
  }
  return `이미지 ${Number(template.imageCount || 0)}개 · 티어 ${Number(template.tierCount || 0)}줄`;
}

function compactTemplateUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("piku.co.kr")) {
      return parsed.pathname.replace(/^\/w\//, "piku/");
    }
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
  const importedMode = inferGameModeFromUrl(templateUrl);
  if (importedMode) {
    state.gameMode = importedMode;
    localStorage.setItem("mtm:gameMode", state.gameMode);
    applyGameModeUI();
  }
  els.tierUrlInput.value = templateUrl;
  setCreateTab("direct");
  setTemplateSearchStatus("원본 사이트에서 선택한 링크를 받았습니다.");

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
  socket.emit("room:join", { roomId, nickname: state.nickname, hostToken: getHostToken(roomId) });
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
  state.selectedItemId = null;
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
    control.disabled = !hasNickname || state.isCreatingRoom;
  });
}

function getRoomCreationProgressLabel(mode, bracketSize = 0) {
  const normalizedMode = normalizeGameMode(mode);
  if (normalizedMode !== ROOM_MODE_WORLDCUP) return "티어메이커 방";
  return bracketSize ? `${bracketSize}강 월드컵 방` : "월드컵 방";
}

function startRoomCreateProgress(label) {
  clearRoomCreateTimer();
  clearRoomCreateHideTimer();
  state.isCreatingRoom = true;
  state.roomCreateProgress = 6;
  state.roomCreateStartedAt = Date.now();
  setRoomCreationBusy(true);

  els.roomCreateProgress.hidden = false;
  els.roomCreateProgress.classList.remove("is-error");
  els.roomCreateProgressTitle.textContent = "방 생성 중";
  els.roomCreateProgressText.textContent = `${label}을 준비하고 있습니다. 후보 이미지가 많으면 시간이 조금 걸릴 수 있습니다.`;
  updateRoomCreateProgress(6);

  state.roomCreateTimer = window.setInterval(() => {
    const elapsed = Date.now() - state.roomCreateStartedAt;
    const eased = 92 - 86 * Math.exp(-elapsed / 9000);
    const nextProgress = Math.max(state.roomCreateProgress, Math.min(92, eased));
    state.roomCreateProgress = nextProgress;
    updateRoomCreateProgress(nextProgress);

    if (elapsed > 8000) {
      els.roomCreateProgressText.textContent = `${label} 후보 이미지를 수집하고 있습니다. 큰 월드컵일수록 조금 더 걸립니다.`;
    } else if (elapsed > 3000) {
      els.roomCreateProgressText.textContent = `${label} 템플릿 데이터를 불러오는 중입니다.`;
    }
  }, 250);
}

function completeRoomCreateProgress(message = "방 생성 완료") {
  clearRoomCreateTimer();
  state.roomCreateProgress = 100;
  updateRoomCreateProgress(100);
  els.roomCreateProgress.classList.remove("is-error");
  els.roomCreateProgressTitle.textContent = "방 생성 완료";
  els.roomCreateProgressText.textContent = message;
  state.roomCreateHideTimer = window.setTimeout(() => {
    hideRoomCreateProgress();
  }, 650);
}

function failRoomCreateProgress(message = "방 생성에 실패했습니다.") {
  clearRoomCreateTimer();
  els.roomCreateProgress.classList.add("is-error");
  els.roomCreateProgressTitle.textContent = "방 생성 실패";
  els.roomCreateProgressText.textContent = message;
  updateRoomCreateProgress(Math.max(12, state.roomCreateProgress));
  state.roomCreateHideTimer = window.setTimeout(() => {
    hideRoomCreateProgress();
  }, 1800);
}

function hideRoomCreateProgress() {
  clearRoomCreateTimer();
  clearRoomCreateHideTimer();
  els.roomCreateProgress.hidden = true;
  els.roomCreateProgress.classList.remove("is-error");
  state.isCreatingRoom = false;
  state.roomCreateProgress = 0;
  setRoomCreationBusy(false);
  updateRoomCreateProgress(0);
}

function clearRoomCreateTimer() {
  if (!state.roomCreateTimer) return;
  window.clearInterval(state.roomCreateTimer);
  state.roomCreateTimer = null;
}

function clearRoomCreateHideTimer() {
  if (!state.roomCreateHideTimer) return;
  window.clearTimeout(state.roomCreateHideTimer);
  state.roomCreateHideTimer = null;
}

function updateRoomCreateProgress(value) {
  const progress = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  const elapsedSeconds = state.roomCreateStartedAt
    ? Math.max(0, Math.floor((Date.now() - state.roomCreateStartedAt) / 1000))
    : 0;
  els.roomCreateProgressBar.style.width = `${progress}%`;
  els.roomCreateProgressPercent.textContent = `${progress}%`;
  els.roomCreateProgressElapsed.textContent = `${elapsedSeconds}초`;
}

function setRoomCreationBusy(isBusy) {
  document
    .querySelectorAll("[data-import-template], [data-import-template-result], #createRoomForm button, #createRoomForm textarea")
    .forEach((control) => {
      control.disabled = isBusy;
    });
  setProfileEnabled();
}

function normalizeGameMode(value) {
  return String(value || ROOM_MODE_TIERMAKER).toLowerCase() === ROOM_MODE_WORLDCUP
    ? ROOM_MODE_WORLDCUP
    : ROOM_MODE_TIERMAKER;
}

function normalizeWorldcupBracketSize(value) {
  const size = Number(value || 0);
  return Number.isInteger(size) && size >= 2 && size <= 3000 ? size : 0;
}

function getRoomBracketLabel(room) {
  if (normalizeGameMode(room?.mode) !== ROOM_MODE_WORLDCUP) return "방";
  const bracketSize = Number(room?.bracketSize || room?.imageCount || 0);
  return bracketSize ? `${bracketSize}강` : "월드컵 방";
}

function getRoomDisplayTitle(room) {
  const title = String(room?.title || "방");
  if (normalizeGameMode(room?.mode) !== ROOM_MODE_WORLDCUP) return title;
  const bracketLabel = getRoomBracketLabel(room);
  return bracketLabel === "월드컵 방" ? title : `${title} · ${bracketLabel} 방`;
}

function inferGameModeFromUrl(value) {
  try {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const hostname = new URL(withProtocol).hostname.toLowerCase();
    if (hostname.endsWith("piku.co.kr")) return ROOM_MODE_WORLDCUP;
    if (hostname.endsWith("tiermaker.com")) return ROOM_MODE_TIERMAKER;
  } catch (_error) {
    return "";
  }
  return "";
}

function getModeLabel(mode = state.gameMode) {
  return normalizeGameMode(mode) === ROOM_MODE_WORLDCUP ? "이상형월드컵" : "티어메이커";
}

function setCreateTab(tab) {
  const selectedTab = tab === "direct" ? "direct" : "search";
  els.createTabButtons.forEach((button) => {
    const isActive = button.dataset.createTab === selectedTab;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", String(isActive));
    button.setAttribute("tabindex", isActive ? "0" : "-1");
  });
  els.createTabPanels.forEach((panel) => {
    panel.hidden = panel.id !== `${selectedTab}Panel`;
  });
}

function applyGameModeUI() {
  els.gameModeInputs.forEach((input) => {
    input.checked = normalizeGameMode(input.value) === state.gameMode;
  });

  const isWorldcup = state.gameMode === ROOM_MODE_WORLDCUP;
  els.sourceUrlLabel.textContent = isWorldcup ? "PIKU 월드컵 링크" : "TierMaker 링크";
  els.tierUrlInput.placeholder = isWorldcup
    ? "https://www.piku.co.kr/w/..."
    : "https://tiermaker.com/create/...";
  els.templateSearchInput.placeholder = isWorldcup
    ? "아이돌, 음식, 애니..."
    : "pokemon, animals, kpop...";
  setTemplateSearchStatus(
    isWorldcup
      ? "PIKU 이상형월드컵을 검색하고 결과에서 바로 방을 열 수 있습니다."
      : "TierMaker 템플릿 이름을 검색하고 결과에서 바로 방을 열 수 있습니다."
  );
  setImportStatus(
    isWorldcup
      ? "PIKU 링크는 공개 랭킹 후보를 가져와 선택한 규모로 방을 만듭니다."
      : "검색 결과에 없는 템플릿만 링크로 직접 열어주세요."
  );
}

function setImportStatus(message, isError = false) {
  els.importStatus.textContent = message;
  els.importStatus.style.color = isError ? "var(--danger)" : "var(--fg-muted)";
  if (shouldShowRoomStatus(message)) {
    showRoomStatus(message, isError);
  }
}

function shouldShowRoomStatus(message) {
  return Boolean(message && (state.currentRoom || state.pendingRoomId || getRoomIdFromHash()));
}

function showRoomStatus(message, isError = false) {
  clearRoomStatusHideTimer();
  els.roomStatusText.textContent = message;
  els.roomStatusToast.hidden = false;
  els.roomStatusToast.classList.toggle("is-error", isError);
  if (!isError) {
    state.roomStatusHideTimer = window.setTimeout(hideRoomStatus, 5000);
  }
}

function hideRoomStatus() {
  clearRoomStatusHideTimer();
  els.roomStatusToast.hidden = true;
  els.roomStatusText.textContent = "";
  els.roomStatusToast.classList.remove("is-error");
}

function clearRoomStatusHideTimer() {
  if (!state.roomStatusHideTimer) return;
  window.clearTimeout(state.roomStatusHideTimer);
  state.roomStatusHideTimer = null;
}

function saveHostToken(roomId, hostToken) {
  if (!roomId || !hostToken) return;
  localStorage.setItem(`${HOST_TOKEN_KEY_PREFIX}${roomId}`, hostToken);
}

function getHostToken(roomId) {
  return roomId ? localStorage.getItem(`${HOST_TOKEN_KEY_PREFIX}${roomId}`) || "" : "";
}

function hasHostToken(roomId) {
  return Boolean(getHostToken(roomId));
}

function isCurrentPlayerHost() {
  return Boolean(state.currentRoom?.players?.some((player) => player.id === socket.id && player.isHost));
}

function readStoredBoardZoom() {
  const stored = Number(localStorage.getItem("mtm:boardZoom"));
  if (Number.isFinite(stored)) {
    return clampBoardZoom(stored);
  }
  return 1;
}

function changeBoardZoom(delta) {
  setBoardZoom(state.boardZoom + delta);
}

function setBoardZoom(value) {
  state.boardZoom = clampBoardZoom(value);
  localStorage.setItem("mtm:boardZoom", String(state.boardZoom));
  applyBoardZoom();
}

function applyBoardZoom() {
  els.tierBoard.style.setProperty("--board-zoom", String(state.boardZoom));
  updateZoomControls();
}

function updateZoomControls() {
  const hasTierRoom = Boolean(state.currentRoom && normalizeGameMode(state.currentRoom.mode) === ROOM_MODE_TIERMAKER);
  els.zoomOutButton.disabled = !hasTierRoom || state.boardZoom <= MIN_BOARD_ZOOM;
  els.zoomInButton.disabled = !hasTierRoom || state.boardZoom >= MAX_BOARD_ZOOM;
  els.zoomLevelLabel.textContent = `${Math.round(state.boardZoom * 100)}%`;
}

function clampBoardZoom(value) {
  const rounded = Math.round(Number(value) * 100) / 100;
  if (!Number.isFinite(rounded)) return 1;
  return Math.min(MAX_BOARD_ZOOM, Math.max(MIN_BOARD_ZOOM, rounded));
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
    els.roomList.innerHTML = `<div class="room-card room-card-empty"><strong>${icon("door-open")}열린 방 없음</strong><span class="room-meta">링크로 새 방을 열어보세요</span></div>`;
    hydrateIcons();
    return;
  }

  els.roomList.innerHTML = state.rooms
    .map(
      (room) => {
        const canDelete = hasHostToken(room.id);
        const displayTitle = getRoomDisplayTitle(room);
        return `
          <article class="room-card">
            <div class="room-card-main">
              <strong title="${escapeHtml(displayTitle)}">${icon(normalizeGameMode(room.mode) === ROOM_MODE_WORLDCUP ? "trophy" : "rows-3")}${escapeHtml(displayTitle)}</strong>
              <div class="room-meta">${room.id} · ${escapeHtml(getModeLabel(room.mode))} · ${escapeHtml(getRoomItemMeta(room))}</div>
            </div>
            <div class="room-card-actions">
              <button type="button" class="button button-ghost" data-join-room="${room.id}">${buttonContent("log-in", "입장")}</button>
              ${canDelete ? `<button type="button" class="button button-danger" data-delete-room="${room.id}">${buttonContent("trash-2", "삭제")}</button>` : ""}
            </div>
          </article>
        `;
      }
    )
    .join("");

  els.roomList.querySelectorAll("[data-join-room]").forEach((button) => {
    button.addEventListener("click", () => joinRoom(button.dataset.joinRoom));
  });
  els.roomList.querySelectorAll("[data-delete-room]").forEach((button) => {
    button.addEventListener("click", () => confirmDeleteRoom(button.dataset.deleteRoom));
  });
  hydrateIcons();
}

function getRoomItemMeta(room) {
  return normalizeGameMode(room?.mode) === ROOM_MODE_WORLDCUP
    ? `${Number(room?.bracketSize || room?.imageCount || 0)}강 · 후보 ${Number(room?.imageCount || 0)}`
    : `이미지 ${Number(room?.imageCount || 0)}`;
}

function renderWorkspace() {
  const room = state.currentRoom;
  const roomIdFromHash = getRoomIdFromHash();
  const pendingRoomId = state.pendingRoomId || roomIdFromHash;
  const hasRoom = Boolean(room);
  const isTierRoom = hasRoom && normalizeGameMode(room.mode) === ROOM_MODE_TIERMAKER;
  const isWorldcupRoom = hasRoom && normalizeGameMode(room.mode) === ROOM_MODE_WORLDCUP;
  applyScreenMode();
  document.body.classList.toggle("has-current-room", hasRoom);
  document.body.classList.toggle("worldcup-room", isWorldcupRoom);
  els.emptyState.hidden = hasRoom;
  els.boardWrap.hidden = !hasRoom;
  els.playerList.hidden = !hasRoom;
  els.toolbarActions.hidden = !hasRoom;
  const isHost = hasRoom && isCurrentPlayerHost();
  const hideTierTools = hasRoom && !isTierRoom;
  els.zoomControl.hidden = hideTierTools;
  els.addImageButton.hidden = hideTierTools;
  els.addTierButton.hidden = hideTierTools;
  els.saveImageButton.hidden = hideTierTools;
  els.addImageButton.disabled = !isTierRoom;
  els.addTierButton.disabled = !isTierRoom || !isHost;
  els.saveImageButton.disabled = !isTierRoom;
  els.copyRoomButton.disabled = !hasRoom;
  els.resetRoomButton.hidden = !isHost;
  els.resetRoomButton.disabled = !isHost;
  els.deleteRoomButton.hidden = !isHost;
  els.deleteRoomButton.disabled = !isHost;
  updateZoomControls();

  if (!room) {
    state.selectedItemId = null;
    hideRoomStatus();
    els.copyStatus.textContent = "";
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
    els.worldcupBoard.innerHTML = "";
    els.tierBoard.hidden = false;
    els.worldcupBoard.hidden = true;
    els.playerList.innerHTML = "";
    renderPlayers();
    return;
  }

  els.roomCodeLabel.textContent = `ROOM ${room.id}`;
  els.workspaceTitle.textContent = getRoomDisplayTitle(room);
  if (state.selectedItemId && !room.items.some((item) => item.id === state.selectedItemId)) {
    state.selectedItemId = null;
  }
  els.tierBoard.hidden = !isTierRoom;
  els.worldcupBoard.hidden = !isWorldcupRoom;
  if (isTierRoom) {
    renderBoard(room);
    els.worldcupBoard.innerHTML = "";
  } else {
    els.tierBoard.innerHTML = "";
    renderWorldcup(room);
  }
  renderPlayers();
}

function renderBoard(room) {
  const canEditTiers = isCurrentPlayerHost();
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
        lane.kind === "tier" && canEditTiers
          ? ` draggable="true" data-tier-drag-handle data-tier-id="${escapeHtml(lane.id)}" aria-label="${escapeHtml(lane.label)} 순서 이동"`
          : "";
      const tierHandleIcon =
        lane.kind === "tier" && canEditTiers ? `<span class="tier-drag-icon" aria-hidden="true">${icon("grip-vertical")}</span>` : "";
      return `
        <section class="${lane.kind === "pool" ? "pool-row" : "tier-row"}" data-lane-id="${lane.id}">
          <div class="tier-label-cell" data-lane-target="${lane.id}" style="--tier-color: ${lane.color}"${tierDragAttrs}>
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
  els.tierBoard.querySelectorAll("[data-lane-target]").forEach(bindLaneTargetEvents);
  els.tierBoard.querySelectorAll("[data-tier-drag-handle]").forEach(bindTierDragEvents);
  bindTierBoardReorderEvents();
  renderMoveSelection();
  hydrateIcons();
}

function renderWorldcup(room) {
  const worldcup = room.worldcup || {};
  const champion = worldcup.championId ? room.items.find((item) => item.id === worldcup.championId) : null;
  const pairItems = (worldcup.currentPair || [])
    .map((itemId) => room.items.find((item) => item.id === itemId))
    .filter(Boolean);

  if (worldcup.completed && champion) {
    els.worldcupBoard.innerHTML = `
      <section class="worldcup-stage is-complete">
        <div class="worldcup-header">
          <span class="coordinate">WINNER</span>
          <h3>${escapeHtml(getItemDisplayName(champion))}</h3>
          <p>이상형월드컵이 끝났습니다. 방장이 초기화하면 같은 후보로 다시 시작합니다.</p>
        </div>
        <button type="button" class="worldcup-winner" data-preview-worldcup-item="${escapeHtml(champion.id)}">
          <img src="${getItemImageSrc(champion)}" alt="${escapeHtml(getItemDisplayName(champion))}" loading="lazy" decoding="async"${getItemFallbackImageSrc(champion) ? ` data-fallback-src="${escapeHtml(getItemFallbackImageSrc(champion))}" referrerpolicy="no-referrer"` : ""} />
          <span>${escapeHtml(getItemDisplayName(champion))}</span>
        </button>
      </section>
    `;
    bindWorldcupImages();
    hydrateIcons();
    return;
  }

  if (pairItems.length < 2) {
    els.worldcupBoard.innerHTML = `
      <section class="worldcup-stage">
        <div class="worldcup-header">
          <span class="coordinate">WAIT</span>
          <h3>대결 준비 중</h3>
          <p>후보를 충분히 가져오지 못했거나 다음 대결을 준비하고 있습니다.</p>
        </div>
      </section>
    `;
    hydrateIcons();
    return;
  }

  const totalVotes = (worldcup.votes || []).length;
  const playerCount = Number(worldcup.playerCount || room.players?.length || 1);
  const myVote = (worldcup.votes || []).find((vote) => vote.playerId === socket.id)?.itemId || "";
  const isTieBreaking = Boolean(worldcup.tieBreak);
  const bracketLabel = Number(worldcup.bracketSize || room.bracketSize || room.imageCount || 0);

  els.worldcupBoard.innerHTML = `
    <section class="worldcup-stage${isTieBreaking ? " is-resolving" : ""}">
      <div class="worldcup-header">
        <span class="coordinate">${bracketLabel ? `${bracketLabel}강 · ` : ""}ROUND ${Number(worldcup.round || 1)} · MATCH ${Number(worldcup.match || 1)}</span>
        <h3>${isTieBreaking ? "동률입니다. 랜덤 판정 중" : "더 마음에 드는 쪽을 선택하세요"}</h3>
        <p>${isTieBreaking ? "모든 참가자에게 같은 결과가 적용됩니다." : `${totalVotes}/${playerCount}명 선택 · 과반이면 다음 대결로 넘어갑니다.`}</p>
      </div>
      ${isTieBreaking ? renderWorldcupTieBreak(room, worldcup) : ""}
      <div class="worldcup-match">
        ${pairItems.map((item) => renderWorldcupChoice(item, worldcup, myVote, isTieBreaking)).join("")}
      </div>
      <div class="worldcup-progress">
        <span>이번 라운드 남은 후보 ${Number(worldcup.remainingInRound || 0)}개</span>
        <span>다음 라운드 진출 ${Number(worldcup.nextRoundCount || 0)}개</span>
      </div>
    </section>
  `;

  els.worldcupBoard.querySelectorAll("[data-worldcup-vote]").forEach((button) => {
    button.addEventListener("click", async () => {
      await voteWorldcup(button.dataset.worldcupVote);
    });
  });
  bindWorldcupImages();
  hydrateIcons();
}

function renderWorldcupChoice(item, worldcup, myVote, isTieBreaking = false) {
  const displayName = getItemDisplayName(item);
  const voteCount = Number(worldcup.voteCounts?.[item.id] || 0);
  const voted = myVote === item.id;
  const selectedByRandom = worldcup.tieBreak?.winnerId === item.id;
  return `
    <article class="worldcup-choice${voted ? " is-voted" : ""}${selectedByRandom ? " is-random-target" : ""}">
      <button type="button" class="worldcup-image-button" data-preview-worldcup-item="${escapeHtml(item.id)}" aria-label="${escapeHtml(displayName)} 확대">
        <img src="${getItemImageSrc(item)}" alt="${escapeHtml(displayName)}" loading="lazy" decoding="async"${getItemFallbackImageSrc(item) ? ` data-fallback-src="${escapeHtml(getItemFallbackImageSrc(item))}" referrerpolicy="no-referrer"` : ""} />
      </button>
      <div class="worldcup-choice-body">
        <strong title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</strong>
        <span class="room-meta">${voteCount}표${voted ? " · 내 선택" : ""}</span>
        <button type="button" class="button button-accent wide-button" data-worldcup-vote="${escapeHtml(item.id)}"${isTieBreaking ? " disabled" : ""}>
          ${buttonContent(voted ? "check" : "mouse-pointer-click", "선택")}
        </button>
      </div>
    </article>
  `;
}

function renderWorldcupTieBreak(room, worldcup) {
  const winner = room.items.find((item) => item.id === worldcup.tieBreak?.winnerId);
  const winnerName = winner ? getItemDisplayName(winner) : "선택된 후보";
  return `
    <aside class="worldcup-randomizer" aria-live="polite">
      <div class="coin-flip" aria-hidden="true">
        <span class="coin-face">?</span>
        <span class="coin-face coin-face-back">MTM</span>
      </div>
      <div class="worldcup-random-copy">
        <strong>동률 판정</strong>
        <span>동전던지기로 다음 라운드 진출자를 정하고 있습니다.</span>
        <span class="worldcup-random-result">결과: ${escapeHtml(winnerName)}</span>
      </div>
    </aside>
  `;
}

function bindWorldcupImages() {
  els.worldcupBoard.querySelectorAll("img").forEach((image) => {
    image.addEventListener("error", () => fallbackItemImage(image), { once: true });
  });
  els.worldcupBoard.querySelectorAll("[data-preview-worldcup-item]").forEach((button) => {
    button.addEventListener("dblclick", () => openImagePreview(button.dataset.previewWorldcupItem));
  });
}

async function voteWorldcup(itemId) {
  if (!state.currentRoom || !itemId) return;
  els.copyStatus.textContent = "선택 중";
  try {
    const response = await emitWithAck("worldcup:vote", { itemId });
    if (!response.ok) throw new Error(response.message || "선택에 실패했습니다.");
    els.copyStatus.textContent = response.tieBreak ? "동률 판정 중" : response.advanced ? "다음 대결" : "선택 완료";
  } catch (error) {
    els.copyStatus.textContent = "선택 실패";
    setImportStatus(error.message, true);
  }
}

function renderItem(item) {
  const imageSrc = getItemImageSrc(item);
  const fallbackSrc = getItemFallbackImageSrc(item);
  const displayName = getItemDisplayName(item);
  const active = getItemActiveFocus(item.id);
  const lockedByOther = isItemLockedByOther(item.id);
  const selectedForMove = state.selectedItemId === item.id;
  const activeStyle = active ? ` style="--active-color:${escapeHtml(active.color)}"` : "";
  const activeBadge = active
    ? `<span class="active-owner" title="${escapeHtml(active.nickname)}">${escapeHtml(active.nickname)}</span>`
    : "";
  return `
    <div class="tier-item${active ? " is-active" : ""}${lockedByOther ? " is-locked-by-other" : ""}${selectedForMove ? " is-move-selected" : ""}" draggable="true" data-item-id="${item.id}" aria-label="${escapeHtml(displayName)}"${activeStyle}>
      <img src="${imageSrc}" alt="${escapeHtml(displayName)}" loading="lazy" decoding="async"${fallbackSrc ? ` data-fallback-src="${escapeHtml(fallbackSrc)}" referrerpolicy="no-referrer"` : ""} />
      ${activeBadge}
    </div>
  `;
}

function getItemImageSrc(item) {
  const src = String(item?.src || "");
  if (src.startsWith("data:")) return src;
  if (src) return `/api/image?url=${encodeURIComponent(src)}`;
  return item?.placeholderSrc || "";
}

function getItemFallbackImageSrc(item) {
  const src = String(item?.src || "");
  if (item?.placeholderSrc) return item.placeholderSrc;
  return src.startsWith("data:") ? "" : src;
}

function isPikuOriginalImageUrl(src) {
  return /^https?:\/\/img\.piku\.co\.kr\/w\/uploads\//i.test(src);
}

function bindItemEvents(item) {
  const image = item.querySelector("img");
  image?.addEventListener("error", () => fallbackItemImage(image), { once: true });
  item.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    if (notifyIfItemLocked(item.dataset.itemId)) return;
    setActiveItem(item.dataset.itemId);
  });
  item.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (event.detail > 1) return;
    await handleItemTapMove(item);
  });
  item.addEventListener("dblclick", () => {
    openImagePreview(item.dataset.itemId);
  });
  item.addEventListener("dragstart", (event) => {
    event.stopPropagation();
    if (notifyIfItemLocked(item.dataset.itemId)) {
      event.preventDefault();
      return;
    }
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

async function handleItemTapMove(item) {
  const itemId = item.dataset.itemId;
  if (!itemId) return;

  if (state.selectedItemId && state.selectedItemId !== itemId) {
    const zone = item.closest(".drop-zone");
    if (zone) {
      await moveSelectedItem(zone.dataset.dropZone, itemId);
    }
    return;
  }

  if (notifyIfItemLocked(itemId)) return;
  selectItemForMove(itemId);
}

function fallbackItemImage(image) {
  const fallbackSrc = image.dataset.fallbackSrc;
  if (!fallbackSrc || image.src === fallbackSrc) return;
  image.src = fallbackSrc;
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
  zone.addEventListener("drop", async (event) => {
    if (state.draggedTierId) return;
    event.preventDefault();
    zone.classList.remove("is-over");
    const itemId = event.dataTransfer.getData("text/plain") || state.draggedItemId;
    if (!itemId) return;
    if (notifyIfItemLocked(itemId)) return;
    const beforeElement = getBeforeElement(zone, event.clientX, event.clientY);
    await moveItemWithAck(itemId, zone.dataset.dropZone, beforeElement?.dataset.itemId || null);
  });
  zone.addEventListener("click", async (event) => {
    if (event.target.closest(".tier-item")) return;
    if (await moveSelectedItem(zone.dataset.dropZone, null)) {
      event.stopPropagation();
    }
  });
}

function bindLaneTargetEvents(target) {
  target.addEventListener("click", async (event) => {
    if (state.draggedTierId) return;
    if (await moveSelectedItem(target.dataset.laneTarget, null)) {
      event.stopPropagation();
    }
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

function selectItemForMove(itemId) {
  if (!state.currentRoom || !itemId) return;
  state.selectedItemId = itemId;
  renderMoveSelection();
  els.copyStatus.textContent = "위치 선택";
}

async function moveSelectedItem(laneId, beforeId) {
  const itemId = state.selectedItemId;
  if (!state.currentRoom || !itemId || !laneId || itemId === beforeId) return false;
  if (notifyIfItemLocked(itemId)) {
    clearSelectedItem();
    return false;
  }

  const moved = await moveItemWithAck(itemId, laneId, beforeId || null);
  if (moved) {
    clearSelectedItem();
    clearActiveItem();
  }
  return moved;
}

async function moveItemWithAck(itemId, laneId, beforeId) {
  els.copyStatus.textContent = "이동 중";
  try {
    const response = await emitWithAck("item:move", { itemId, laneId, beforeId });
    if (!response.ok) throw new Error(response.message || "이미지를 이동할 수 없습니다.");
    els.copyStatus.textContent = "이미지 이동됨";
    return true;
  } catch (error) {
    els.copyStatus.textContent = "이동 실패";
    setImportStatus(error.message, true);
    return false;
  }
}

function clearSelectedItem() {
  if (!state.selectedItemId) return;
  state.selectedItemId = null;
  renderMoveSelection();
}

function renderMoveSelection() {
  els.tierBoard.classList.toggle("has-move-selection", Boolean(state.selectedItemId));
  els.tierBoard.querySelectorAll(".tier-item").forEach((tile) => {
    tile.classList.toggle("is-move-selected", tile.dataset.itemId === state.selectedItemId);
  });
}

function mapActiveItems(activeItems) {
  return activeItems.reduce((acc, active) => {
    if (active.playerId && active.itemId && !isActiveItemExpired(active)) {
      acc[active.playerId] = active;
    }
    return acc;
  }, {});
}

function getItemActiveFocus(itemId) {
  return Object.values(state.activeItems).find((active) => active.itemId === itemId && !isActiveItemExpired(active)) || null;
}

function getItemLockOwner(itemId) {
  return (
    Object.values(state.activeItems).find(
      (active) => active.itemId === itemId && active.playerId !== socket.id && !isActiveItemExpired(active)
    ) || null
  );
}

function isActiveItemExpired(active) {
  const lockedAt = Number(active?.lockedAt || 0);
  return !lockedAt || Date.now() - lockedAt > ITEM_LOCK_TTL_MS;
}

function pruneLocalActiveItems() {
  if (!Object.values(state.activeItems).some(isActiveItemExpired)) return;
  state.activeItems = mapActiveItems(Object.values(state.activeItems));
  renderItemHighlights();
}

function isItemLockedByOther(itemId) {
  return Boolean(getItemLockOwner(itemId));
}

function notifyIfItemLocked(itemId) {
  const lockOwner = getItemLockOwner(itemId);
  if (!lockOwner) return false;
  els.copyStatus.textContent = "사용 중";
  setImportStatus(`${lockOwner.nickname || "다른 참가자"}님이 잡고 있는 이미지는 이동할 수 없습니다.`, true);
  return true;
}

function setActiveItem(itemId) {
  if (!state.currentRoom || !itemId) return;
  if (notifyIfItemLocked(itemId)) return;
  const player = state.currentRoom.players.find((entry) => entry.id === socket.id);
  if (player) {
    state.activeItems[socket.id] = {
      itemId,
      playerId: socket.id,
      nickname: player.nickname,
      color: player.color,
      lockedAt: Date.now(),
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
    const lockedByOther = isItemLockedByOther(tile.dataset.itemId);
    tile.classList.toggle("is-active", Boolean(active));
    tile.classList.toggle("is-locked-by-other", lockedByOther);
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
  els.lightboxImage.dataset.fallbackSrc = getItemFallbackImageSrc(item);
  els.lightboxImage.onerror = () => fallbackItemImage(els.lightboxImage);
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
  els.lightboxImage.removeAttribute("data-fallback-src");
  els.lightboxImage.onerror = null;
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
  els.copyStatus.textContent = "주소 확인 중";
  const baseUrl = await waitForShareBaseUrl();
  if (!baseUrl) {
    els.copyStatus.textContent = "터널 준비 중";
    setImportStatus(
      "Cloudflare Tunnel 주소가 아직 준비 중입니다. EXE 창에 Public URL이 표시되면 다시 눌러주세요.",
      true
    );
    return;
  }

  const link = `${baseUrl}/#room=${state.currentRoom.id}`;

  try {
    await writeClipboard(link);
    els.copyStatus.textContent = "초대 링크 복사됨";
    setImportStatus(`초대 링크를 클립보드에 복사했습니다: ${link}`);
  } catch (_error) {
    els.copyStatus.textContent = "복사 실패";
    setImportStatus(`복사가 막혔습니다. 이 링크를 직접 복사해주세요: ${link}`, true);
  }
}

function confirmDeleteRoom(roomId) {
  if (!roomId) return;
  const room =
    state.currentRoom?.id === roomId
      ? state.currentRoom
      : state.rooms.find((entry) => entry.id === roomId);
  const roomTitle = getRoomDisplayTitle(room || { id: roomId, title: "이 방" });
  openConfirmDialog({
    title: "방 삭제",
    message: `"${roomTitle}"을 삭제합니다. 이 작업은 되돌릴 수 없고, 접속 중인 참가자는 메인 화면으로 돌아갑니다.`,
    actionLabel: "방 삭제",
    actionIcon: "trash-2",
    onConfirm: () => deleteRoom(roomId),
  });
}

async function deleteRoom(roomId) {
  if (!roomId) return;

  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`, {
      method: "DELETE",
      headers: {
        "x-host-token": getHostToken(roomId),
      },
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

function confirmResetRoom() {
  if (!state.currentRoom) return;
  openConfirmDialog({
    title: "방 초기화",
    message: "현재 방의 배치와 진행 상태를 처음 상태로 되돌립니다. 참가자는 방에 그대로 남습니다.",
    actionLabel: "초기화",
    actionIcon: "rotate-ccw",
    onConfirm: resetRoom,
  });
}

async function resetRoom() {
  if (!state.currentRoom) return;
  try {
    const response = await emitWithAck("room:reset", {});
    if (!response.ok) throw new Error(response.message || "초기화에 실패했습니다.");
    setImportStatus("방을 초기화했습니다.");
  } catch (error) {
    setImportStatus(error.message, true);
  }
}

function openConfirmDialog({ title, message, actionLabel, actionIcon = "check", onConfirm }) {
  state.pendingConfirmAction = typeof onConfirm === "function" ? onConfirm : null;
  els.confirmDialogTitle.textContent = title || "확인";
  els.confirmDialogMessage.textContent = message || "이 작업을 진행할까요?";
  els.acceptConfirmDialogButton.innerHTML = buttonContent(actionIcon, actionLabel || "확인");
  els.confirmDialog.hidden = false;
  hydrateIcons();
  requestAnimationFrame(() => els.cancelConfirmDialogButton.focus());
}

function closeConfirmDialog() {
  state.pendingConfirmAction = null;
  els.confirmDialog.hidden = true;
}

async function acceptConfirmDialog() {
  const action = state.pendingConfirmAction;
  closeConfirmDialog();
  if (action) await action();
}

function getShareBaseUrl() {
  if (state.publicBaseUrl && !isLocalUrl(state.publicBaseUrl)) {
    return state.publicBaseUrl;
  }

  if (!isLocalUrl(window.location.origin)) {
    return window.location.origin;
  }

  return "";
}

async function waitForShareBaseUrl() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await loadConfig();
    const baseUrl = getShareBaseUrl();
    if (baseUrl) return baseUrl;
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }

  return "";
}

function isLocalUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return isLocalHostname(hostname) || isPrivateIpv4(hostname);
  } catch (_error) {
    return true;
  }
}

function isLocalHostname(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "0.0.0.0" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".local")
  );
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

async function writeClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (_error) {
      // Fall through to the selection-based copy path for browsers that gate clipboard permission.
    }
  }

  if (copyWithSelection(text)) {
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
