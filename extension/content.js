(() => {
  const PANEL_ID = "multi-tier-maker-extension-panel";
  const DEFAULT_SERVER_URL = "http://localhost:8000";
  const templateImagePattern = /tiermaker\.com\/images\/+(?:media\/)?template_images\//i;

  if (document.getElementById(PANEL_ID)) return;

  const panel = document.createElement("section");
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <div class="mtm-head">
      <strong>Multiplay Tier Maker</strong>
      <button type="button" class="mtm-close" aria-label="닫기">×</button>
    </div>
    <label class="mtm-label">
      서버 주소
      <input class="mtm-server" spellcheck="false" />
    </label>
    <div class="mtm-found">템플릿을 확인하는 중입니다.</div>
    <button type="button" class="mtm-apply">현재 템플릿 적용</button>
    <button type="button" class="mtm-refresh">다시 확인</button>
    <div class="mtm-status" role="status" aria-live="polite"></div>
  `;

  const style = document.createElement("style");
  style.textContent = `
    #${PANEL_ID} {
      position: fixed;
      right: 18px;
      top: 86px;
      z-index: 2147483647;
      width: 304px;
      padding: 14px;
      border: 1px solid #2dd4bf;
      border-radius: 8px;
      color: #f6efe3;
      background: #151312;
      box-shadow: 0 18px 44px rgba(0, 0, 0, .38);
      font: 14px Arial, sans-serif;
    }
    #${PANEL_ID} * { box-sizing: border-box; }
    #${PANEL_ID} .mtm-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 10px;
    }
    #${PANEL_ID} strong {
      font-size: 16px;
      line-height: 1.2;
    }
    #${PANEL_ID} .mtm-close {
      width: 30px;
      height: 30px;
      border: 1px solid rgba(246, 239, 227, .24);
      border-radius: 6px;
      color: #f6efe3;
      background: transparent;
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
    }
    #${PANEL_ID} .mtm-label {
      display: grid;
      gap: 6px;
      margin-bottom: 10px;
      color: #c9bead;
      font-weight: 700;
    }
    #${PANEL_ID} .mtm-server {
      width: 100%;
      min-height: 36px;
      border: 1px solid rgba(246, 239, 227, .24);
      border-radius: 6px;
      padding: 8px 9px;
      color: #f6efe3;
      background: #11100f;
      font: 13px Consolas, monospace;
    }
    #${PANEL_ID} .mtm-found,
    #${PANEL_ID} .mtm-status {
      margin: 8px 0;
      color: #c9bead;
      font-size: 12px;
      line-height: 1.4;
      word-break: keep-all;
    }
    #${PANEL_ID} .mtm-apply,
    #${PANEL_ID} .mtm-refresh {
      width: 100%;
      min-height: 38px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 800;
    }
    #${PANEL_ID} .mtm-apply {
      border: 0;
      color: #061311;
      background: #2dd4bf;
    }
    #${PANEL_ID} .mtm-refresh {
      margin-top: 8px;
      border: 1px solid rgba(246, 239, 227, .24);
      color: #f6efe3;
      background: transparent;
    }
    #${PANEL_ID} button:disabled {
      cursor: not-allowed;
      opacity: .55;
    }
  `;

  document.documentElement.appendChild(style);
  document.body.appendChild(panel);

  const serverInput = panel.querySelector(".mtm-server");
  const foundText = panel.querySelector(".mtm-found");
  const statusText = panel.querySelector(".mtm-status");
  const applyButton = panel.querySelector(".mtm-apply");
  const refreshButton = panel.querySelector(".mtm-refresh");
  const closeButton = panel.querySelector(".mtm-close");

  loadServerUrl();
  refreshSummary();

  closeButton.addEventListener("click", () => panel.remove());
  refreshButton.addEventListener("click", refreshSummary);
  serverInput.addEventListener("change", saveServerUrl);
  applyButton.addEventListener("click", applyTemplate);

  function loadServerUrl() {
    if (!globalThis.chrome?.storage?.sync) {
      serverInput.value = DEFAULT_SERVER_URL;
      return;
    }

    chrome.storage.sync.get({ mtmServerUrl: DEFAULT_SERVER_URL }, (items) => {
      serverInput.value = normalizeServerUrl(items.mtmServerUrl || DEFAULT_SERVER_URL);
    });
  }

  function saveServerUrl() {
    serverInput.value = normalizeServerUrl(serverInput.value);
    if (globalThis.chrome?.storage?.sync) {
      chrome.storage.sync.set({ mtmServerUrl: serverInput.value });
    }
  }

  function normalizeServerUrl(value) {
    const trimmed = String(value || "").trim() || DEFAULT_SERVER_URL;
    return trimmed.replace(/\/+$/, "");
  }

  function refreshSummary() {
    const snapshot = collectTemplate();
    foundText.textContent = `이미지 ${snapshot.imageUrls.length}개, 티어 ${snapshot.rowTexts.length}줄을 찾았습니다.`;
    statusText.textContent = location.pathname.startsWith("/create/")
      ? "원본 페이지에서 바로 적용할 수 있습니다."
      : "TierMaker create 페이지에서 사용하세요.";
  }

  async function applyTemplate() {
    saveServerUrl();
    const serverUrl = normalizeServerUrl(serverInput.value);
    const snapshot = collectTemplate();

    if (!snapshot.imageUrls.length) {
      statusText.textContent = "이미지 목록을 찾지 못했습니다. 페이지 로드가 끝난 뒤 다시 눌러주세요.";
      return;
    }

    applyButton.disabled = true;
    applyButton.textContent = "가져오는 중";
    statusText.textContent = "Multiplay Tier Maker 서버로 템플릿을 보내는 중입니다.";

    try {
      const response = await fetch(`${serverUrl}/api/rooms/snapshot`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(snapshot),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "템플릿 가져오기에 실패했습니다.");

      statusText.textContent = data.existing ? "이미 열린 방으로 이동합니다." : "방을 만들었습니다.";
      window.open(`${serverUrl}/#room=${encodeURIComponent(data.room.id)}`, "_blank", "noopener");
    } catch (error) {
      statusText.textContent = `${error.message || "연결 실패"} 서버 주소와 실행 상태를 확인해주세요.`;
    } finally {
      applyButton.disabled = false;
      applyButton.textContent = "현재 템플릿 적용";
    }
  }

  function collectTemplate() {
    const imageCandidates = [];
    for (const image of document.images) {
      imageCandidates.push(image.currentSrc, image.src);
      for (const attr of ["data-src", "data-original", "data-lazy-src", "data-url"]) {
        imageCandidates.push(image.getAttribute(attr));
      }
      imageCandidates.push(...srcsetUrls(image.getAttribute("srcset")));
    }

    for (const element of document.querySelectorAll("[style*='template_images']")) {
      const matches = String(element.getAttribute("style") || "").match(/url\((['"]?)(.*?)\1\)/gi) || [];
      for (const match of matches) {
        imageCandidates.push(match.replace(/^url\((['"]?)/i, "").replace(/['"]?\)$/i, ""));
      }
    }

    imageCandidates.push(
      ...(document.documentElement.innerHTML.match(
        /https?:\/\/(?:www\.)?tiermaker\.com\/images\/+(?:media\/)?template_images\/[^"'\s<>&)]+/gi
      ) || [])
    );

    const labelSelectors = [".tier-label", ".label-holder", ".tier-list-row .label", ".tier .label", ".label"];
    const rowTexts = unique(
      labelSelectors.flatMap((selector) =>
        Array.from(document.querySelectorAll(selector)).map((element) => cleanText(element.textContent, 32))
      )
    ).filter((label) => label && !/choose a label|edit label|delete row|add a row/i.test(label));

    return {
      title: cleanText(document.querySelector("h1")?.textContent || document.title || "TierMaker Room", 140),
      sourceUrl: location.href,
      rowTexts: rowTexts.slice(0, 32),
      imageUrls: unique(imageCandidates.map(resolveUrl).filter((url) => templateImagePattern.test(url))).slice(0, 3000),
    };
  }

  function srcsetUrls(value) {
    return String(value || "")
      .split(",")
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean);
  }

  function resolveUrl(value) {
    try {
      return new URL(String(value || "").trim(), location.href).toString();
    } catch (_error) {
      return "";
    }
  }

  function cleanText(value, length) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, length);
  }

  function unique(values) {
    return Array.from(new Set(values.filter(Boolean)));
  }
})();
