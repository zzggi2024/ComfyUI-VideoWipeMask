import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import {
    buildV2LearnPayload,
    defaultLearningSelection,
    interactiveWaitNodeIds,
    learningMenuHeight,
    normalizeModes,
    previewLayout,
    progressMatchesNode,
    rectanglePoints,
    waitSessionKey,
} from "./geometry.mjs?v=20260928";

const NODE_CLASS = "VideoWipeMask_ManualTrack";
const WATERMARK_DATA_WIDGET = "水印数据";
const TEXT_MODE_WIDGET = "文字检测";
const WATERMARK_MODE_WIDGET = "水印检测";
const WATERMARK_PROFILE_WIDGET = "当前水印档案";
const TEXT_WATERMARK_MODE_WIDGET = "文字水印检测";
const TEXT_WATERMARK_TEXT_WIDGET = "水印文字";
const MODULE_SECTIONS = [
    { title: "字幕检测", anchor: TEXT_MODE_WIDGET },
    { title: "文字水印", anchor: TEXT_WATERMARK_MODE_WIDGET },
    { title: "图案水印", anchor: WATERMARK_MODE_WIDGET },
];
const MODULE_LABELS = [
    [TEXT_MODE_WIDGET, "字幕检测"],
    ["检测指定文字", "字幕文字"],
    ["文字检测阈值", "字幕检测阈值"],
    [TEXT_WATERMARK_MODE_WIDGET, "文字水印"],
    [TEXT_WATERMARK_TEXT_WIDGET, "水印文字"],
    [WATERMARK_MODE_WIDGET, "图案水印"],
    ["水印检测阈值", "图案水印阈值"],
    [WATERMARK_PROFILE_WIDGET, "水印档案（文字/图案水印共用标记）"],
];
const RANDOM_SEED_WIDGET = "随机种";
const CONTROL_AFTER_GENERATE_WIDGET = "control_after_generate";
const DIRECTION_WIDGETS = ["向上扩展", "向下扩展", "向左扩展", "向右扩展"];
const PROFILE_ENDPOINT = "/videowipemask/v2/profiles";
const LEARN_ENDPOINT = "/videowipemask/v2/learn";
const MODE_SELECT_ENDPOINT = "/videowipemask/v2/select-mode";
const WAITING_EVENT = "videowipemask.v2.waiting";
const MODE_REQUIRED_EVENT = "videowipemask.v2.mode-required";
const PREVIEW_READY_EVENT = "videowipemask.v2.preview-ready";
const NEW_PROFILE_VALUE = "__new__";
const NODE_WIDTH = 460;
const SEED_CONTROL_VALUES = ["fixed", "increment", "decrement", "randomize"];
const waitingSessions = new Map();
const queuedNodesBySession = new Map();

function findWidget(node, name) {
    return node.widgets?.find((item) => item?.name === name);
}

function normalizedSeedValue(value) {
    if (value === null || value === undefined || value === "") return 0;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) return 0;
    return Math.trunc(numeric) >>> 0;
}

function removeDuplicateSeedControls(node) {
    const seed = findWidget(node, RANDOM_SEED_WIDGET);
    const widgets = node.widgets || [];
    const duplicates = widgets.filter((item) => item?.name === CONTROL_AFTER_GENERATE_WIDGET);
    for (const extra of duplicates.slice(1)) {
        const index = widgets.indexOf(extra);
        if (index >= 0) widgets.splice(index, 1);
        const linked = seed?.linkedWidgets;
        if (Array.isArray(linked)) {
            const position = linked.indexOf(extra);
            if (position >= 0) linked.splice(position, 1);
        }
    }
}

function ensureNativeSeedControl(node) {
    const seed = findWidget(node, RANDOM_SEED_WIDGET);
    if (!seed) return;
    // 后端已经声明 control_after_generate 时由前端自己生成联动控件，不能再加一个同名的。
    // 后端已在选项里声明 control_after_generate，前端会自己生成联动控件；
    // 这里绝不再新增控件，否则加载期插入控件会打乱 ComfyUI 按位置恢复的值。
    seed.value = normalizedSeedValue(seed.value);
    seed.options = seed.options || {};
    seed.options.control_after_generate = true;
    const control = findWidget(node, CONTROL_AFTER_GENERATE_WIDGET);
    if (control && !Array.isArray(seed.linkedWidgets)) seed.linkedWidgets = [];
    if (control && !seed.linkedWidgets.includes(control)) seed.linkedWidgets.push(control);
    if (control && !SEED_CONTROL_VALUES.includes(String(control.value))) {
        control.value = "randomize";
    }
    removeDuplicateSeedControls(node);
}

function pluginUrl(path) {
    const value = String(path || "");
    return typeof api.fileURL === "function" ? api.fileURL(value) : api.apiURL(value);
}

function previewUrl(nodeId, promptId, clientId, frame, version, layer = "source") {
    const query = new URLSearchParams({
        node_id: String(nodeId || ""),
        prompt_id: String(promptId || ""),
        client_id: String(clientId || ""),
        frame: String(frame || 1),
        version: String(version || 0),
        layer: String(layer || "source"),
    });
    return pluginUrl(`/videowipemask/preview?${query.toString()}`);
}

function fitNodeLayout(node) {
    const size = node.computeSize?.() || [NODE_WIDTH, node.size?.[1] || 0];
    node.setSize?.([NODE_WIDTH, size[1]]);
    node.setDirtyCanvas?.(true, true);
}

function hideWidget(item) {
    if (!item) return;
    item.hidden = true;
    item.options ??= {};
    item.options.hidden = true;
    item.computeSize = () => [0, -4];
}

function setWidgetDisabled(item, disabled) {
    if (!item) return;
    item.disabled = disabled;
    item.readonly = disabled;
    item.options ??= {};
    item.options.disabled = disabled;
    item.options.readOnly = disabled;
    if (item.inputEl) {
        item.inputEl.disabled = disabled;
        item.inputEl.readOnly = disabled;
    }
}

function compactSerializableWidgetValues(node, data) {
    if (!data || !Array.isArray(data.widgets_values)) return;
    const serializable = (node.widgets || []).filter((widget) => widget && widget.serialize !== false);
    data.widgets_values = serializable.map((widget) => widget.value ?? null);
    data.widgets_values_named = Object.fromEntries(
        serializable.map((widget) => [widget.name, widget.value ?? null]),
    );
}

function bindWidgetValueSerialization(node) {
    if (node.__videoWipeSerializeBound) return;
    const original = node.onSerialize;
    node.onSerialize = function (data) {
        original?.call(this, data);
        compactSerializableWidgetValues(this, data);
    };
    node.__videoWipeSerializeBound = true;
}
async function requestJson(path, options) {
    const response = await fetch(pluginUrl(path), options);
    if (!response.ok) {
        const error = new Error((await response.text()) || `请求失败 (${response.status})`);
        error.status = response.status;
        throw error;
    }
    return response.json();
}

function showConfirmDialog(message) {
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.58);display:flex;align-items:center;justify-content:center;";
        const dialog = document.createElement("div");
        dialog.style.cssText = "display:flex;flex-direction:column;gap:14px;width:min(360px,calc(100vw - 32px));padding:16px;background:#242424;border:1px solid #666;border-radius:6px;color:#eee;box-shadow:0 12px 36px rgba(0,0,0,.5);";
        const text = document.createElement("div");
        text.textContent = message;
        const actions = document.createElement("div");
        actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";
        const cancel = document.createElement("button");
        const confirm = document.createElement("button");
        cancel.textContent = "取消";
        confirm.textContent = "删除";
        for (const button of [cancel, confirm]) {
            button.type = "button";
            button.style.cssText = "border:1px solid #666;border-radius:4px;background:#333;color:#eee;padding:6px 12px;cursor:pointer;";
        }
        confirm.style.cssText += "border-color:#b95d5d;background:#713737;";
        const close = (value) => { overlay.remove(); resolve(value); };
        cancel.addEventListener("click", () => close(false));
        confirm.addEventListener("click", () => close(true));
        overlay.addEventListener("pointerdown", (event) => {
            if (event.target === overlay) close(false);
        });
        actions.append(cancel, confirm);
        dialog.append(text, actions);
        overlay.append(dialog);
        document.body.append(overlay);
        confirm.focus();
    });
}

function showModeSelectionDialog() {
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.62);display:flex;align-items:center;justify-content:center;";
        const dialog = document.createElement("div");
        dialog.style.cssText = "display:flex;flex-direction:column;gap:14px;width:min(380px,calc(100vw - 32px));padding:18px;background:#242424;border:1px solid #666;border-radius:6px;color:#eee;box-shadow:0 12px 36px rgba(0,0,0,.5);";
        const title = document.createElement("div");
        title.textContent = "请选择检测类型";
        title.style.cssText = "font-size:15px;font-weight:600;";
        const actions = document.createElement("div");
        actions.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:8px;";
        const textButton = document.createElement("button");
        const watermarkButton = document.createElement("button");
        const cancelButton = document.createElement("button");
        textButton.textContent = "文字检测";
        watermarkButton.textContent = "水印检测";
        cancelButton.textContent = "取消";
        for (const button of [textButton, watermarkButton, cancelButton]) {
            button.type = "button";
            button.style.cssText = "border:1px solid #666;border-radius:4px;background:#333;color:#eee;padding:8px 10px;cursor:pointer;";
        }
        cancelButton.style.gridColumn = "1 / -1";
        const close = (value) => { overlay.remove(); resolve(value); };
        textButton.addEventListener("click", () => close("text"));
        watermarkButton.addEventListener("click", () => close("watermark"));
        cancelButton.addEventListener("click", () => close(""));
        overlay.addEventListener("pointerdown", (event) => {
            if (event.target === overlay) close("");
        });
        actions.append(textButton, watermarkButton, cancelButton);
        dialog.append(title, actions);
        overlay.append(dialog);
        document.body.append(overlay);
        textButton.focus();
    });
}

async function handleModeRequired(detail) {
    if (!detail?.node_id) return;
    const node = findNode(detail.node_id);
    const mode = await showModeSelectionDialog();
    const payload = {
        node_id: String(detail.node_id || ""),
        prompt_id: String(detail.prompt_id || ""),
        client_id: String(detail.client_id || api.clientId || ""),
        session_id: String(detail.session_id || ""),
        mode: mode || "cancel",
    };
    try {
        await requestJson(MODE_SELECT_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
    } catch (error) {
        node.__videoWipeProgress?.update({
            status: "error",
            message: error.message || "检测类型选择失败",
        });
        return;
    }
    if (!node) return;
    const textMode = findWidget(node, TEXT_MODE_WIDGET);
    const watermarkMode = findWidget(node, WATERMARK_MODE_WIDGET);
    if (textMode) textMode.value = mode === "text";
    if (watermarkMode) watermarkMode.value = mode === "watermark";
    node.__videoWipeEnforceModes?.();
    node.setDirtyCanvas?.(true, true);
}

function syncProfileControls(items, sourceControl, selectedId) {
    const controls = graphNodes()
        .map((node) => node.__videoWipeProfiles)
        .filter(Boolean);
    const sourceIndex = controls.indexOf(sourceControl);
    const selections = controls.map((control, index) => defaultLearningSelection(
        items,
        index === sourceIndex ? selectedId : control.selectedId(),
    ));
    controls.forEach((control, index) => control.apply(items, selections[index]));
}

function createProfileControl(node) {
    const rawWidget = findWidget(node, WATERMARK_PROFILE_WIDGET);
    const root = document.createElement("div");
    root.style.cssText = "display:flex;flex-direction:column;gap:4px;padding:4px 6px;box-sizing:border-box;width:100%;color:#ddd;";
    root.addEventListener("pointerdown", (event) => event.stopPropagation());
    const row = document.createElement("div");
    row.style.cssText = "display:grid;grid-template-columns:auto minmax(0,1fr);gap:7px;align-items:center;";
    const caption = document.createElement("span");
    caption.textContent = "当前水印档案：";
    caption.style.cssText = "font-size:12px;color:#bbb;white-space:nowrap;";
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.style.cssText = "display:flex;align-items:center;justify-content:space-between;min-width:0;width:100%;height:30px;border:1px solid #5c5c5c;border-radius:4px;background:#292929;color:#eee;padding:0 9px;cursor:pointer;text-align:left;";
    const label = document.createElement("span");
    label.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    const arrow = document.createElement("span");
    arrow.textContent = "▾";
    trigger.append(label, arrow);
    row.append(caption, trigger);
    const menu = document.createElement("div");
    menu.style.cssText = "display:none;padding:3px;background:#202020;border:1px solid #626262;border-radius:4px;box-shadow:0 8px 24px rgba(0,0,0,.45);";
    const message = document.createElement("div");
    message.style.cssText = "display:none;color:#d88989;font-size:11px;";
    root.append(row, menu, message);
    let items = [];
    let menuOpen = false;
    let disabled = false;
    let newProfileSelected = false;
    let pendingProfileName = "";
    const selectedId = () => newProfileSelected ? "" : String(rawWidget?.value || "");
    const selectedItem = () => items.find((item) => item.id === selectedId()) || null;
    const setMessage = (value = "") => {
        message.textContent = value;
        message.style.display = value ? "block" : "none";
    };
    const setMenuOpen = (open) => {
        menuOpen = Boolean(open && !disabled);
        menu.style.display = menuOpen ? "block" : "none";
        fitNodeLayout(node);
    };
    const selectNewProfile = () => {
        pendingProfileName = "";
        newProfileSelected = true;
        if (rawWidget) rawWidget.value = "";
        label.textContent = "新建水印档案";
        render();
        setMenuOpen(false);
        node.setDirtyCanvas?.(true, true);
    };
    const render = () => {
        menu.replaceChildren();
        const newLine = document.createElement("div");
        newLine.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr);align-items:center;";
        const newChoose = document.createElement("button");
        newChoose.type = "button";
        newChoose.textContent = "新建水印档案";
        newChoose.disabled = disabled;
        newChoose.style.cssText = `overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:0;border-radius:3px;background:${newProfileSelected ? "#315b3e" : "transparent"};color:#eee;padding:7px;text-align:left;cursor:${disabled ? "not-allowed" : "pointer"};`;
        newChoose.addEventListener("click", selectNewProfile);
        newLine.append(newChoose);
        menu.append(newLine);
        for (const item of items) {
            const ready = Boolean(item.stable_ready);
            const selectable = ready;
            const line = document.createElement("div");
            line.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) 30px;align-items:center;gap:4px;";
            const choose = document.createElement("button");
            choose.type = "button";
            choose.textContent = ready
                ? `${item.name} (${item.sample_count})`
                : `${item.name} (${item.sample_count}) - 尚未完成学习`;
            choose.disabled = disabled || !selectable;
            choose.style.cssText = `overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:0;border-radius:3px;background:${item.id === selectedId() ? "#315b3e" : "transparent"};color:${ready ? "#eee" : selectable ? "#ddd" : "#999"};padding:7px;text-align:left;cursor:${selectable ? "pointer" : "not-allowed"};`;
            choose.addEventListener("click", () => {
                if (!selectable) return;
                control.select(item.id);
            });
            const remove = document.createElement("button");
            remove.type = "button";
            remove.title = `删除 ${item.name}`;
            remove.disabled = disabled;
            remove.style.cssText = "display:grid;place-items:center;width:28px;height:28px;border:0;border-radius:3px;background:transparent;cursor:pointer;";
            const icon = document.createElement("img");
            icon.src = new URL("./icons/trash.svg", import.meta.url).href;
            icon.alt = "删除";
            icon.style.cssText = "width:16px;height:16px;filter:invert(72%) sepia(30%) saturate(800%) hue-rotate(310deg);pointer-events:none;";
            remove.append(icon);
            remove.addEventListener("click", async () => {
                setMenuOpen(false);
                if (!await showConfirmDialog(`确认删除标记“${item.name}”？`)) return;
                try {
                    const payload = await requestJson(`${PROFILE_ENDPOINT}/${encodeURIComponent(item.id)}`, { method: "DELETE" });
                    syncProfileControls(payload.items, control, "");
                } catch (error) {
                    setMessage(error.message);
                }
            });
            line.append(choose, remove);
            menu.append(line);
        }
    };
    const control = {
        apply(nextItems, preferredId = "") {
            items = Array.isArray(nextItems) ? nextItems : [];
            if (pendingProfileName && !items.some((item) => item.name === pendingProfileName)) {
                pendingProfileName = "";
            }
            let explicitId = String(preferredId || "");
            const preferredItem = items.find(
                (item) => item.id === explicitId || item.name === explicitId,
            );
            if (preferredItem) explicitId = preferredItem.id;
            const pendingItem = pendingProfileName && items.find(
                (item) => item.name === pendingProfileName && item.stable_ready,
            );
            if (pendingItem && !explicitId) {
                explicitId = pendingItem.id;
                pendingProfileName = "";
                newProfileSelected = false;
            }
            if (explicitId === NEW_PROFILE_VALUE) newProfileSelected = true;
            else if (explicitId) newProfileSelected = false;
            const nextId = newProfileSelected
                ? ""
                : defaultLearningSelection(items, explicitId || selectedId());
            if (rawWidget && (items.length > 0 || !rawWidget.value)) rawWidget.value = nextId;
            label.textContent = newProfileSelected
                ? pendingProfileName || "新建水印档案"
                : items.find((item) => item.id === nextId)?.name
                || pendingProfileName
                || "请先保存水印";
            trigger.disabled = disabled;
            trigger.style.opacity = disabled ? ".5" : "1";
            if (!items.some((item) => item.stable_ready)) {
                setMessage("请先保存水印");
            } else if (message.textContent === "请先保存水印") {
                setMessage("");
            }
            render();
        },
        async refresh(preferredId = "") {
            try {
                const payload = await requestJson(PROFILE_ENDPOINT);
                control.apply(payload.items, preferredId || selectedId());
                setMessage("");
            } catch (error) {
                control.apply([], "");
                setMessage(error.message);
            }
        },
        selectedId,
        selectedItem,
        setPending(name) {
            pendingProfileName = String(name || "").trim();
            label.textContent = pendingProfileName || "新建水印档案";
            render();
            node.setDirtyCanvas?.(true, true);
        },
        select(id) {
            const value = String(id || "");
            if (value === NEW_PROFILE_VALUE) {
                selectNewProfile();
                return;
            }
            if (!items.some((item) => item.id === value && item.stable_ready)) return;
            pendingProfileName = "";
            newProfileSelected = false;
            rawWidget.value = value;
            label.textContent = items.find((item) => item.id === value)?.name || "请先保存水印";
            render();
            node.setDirtyCanvas?.(true, true);
        },
        setVisible(visible) {
            root.style.display = visible ? "flex" : "none";
            if (!visible) setMenuOpen(false);
            node.setDirtyCanvas?.(true, true);
        },
        setDisabled(nextDisabled) {
            disabled = Boolean(nextDisabled);
            if (disabled) setMenuOpen(false);
            control.apply(items, selectedId());
        },
    };
    trigger.addEventListener("click", () => setMenuOpen(!menuOpen));
    const domWidget = node.addDOMWidget("水印选择", "video_wipe_mask_learning_set", root, { serialize: false });
    domWidget.serialize = false;
    domWidget.computeSize = () => [NODE_WIDTH, learningMenuHeight(items.length + 1, menuOpen, Boolean(message.textContent))];
    control.domWidget = domWidget;
    node.__videoWipeProfiles = control;
    control.apply([], "");
    void control.refresh();
    return domWidget;
}

function createPanel(node) {
    const root = document.createElement("div");
    root.style.cssText = "display:flex;flex-direction:column;gap:6px;padding:6px;box-sizing:border-box;width:100%;background:#171717;color:#ddd;";
    root.addEventListener("pointerdown", (event) => event.stopPropagation());
    const status = document.createElement("div");
    status.style.cssText = "font-size:11px;color:#aaa;min-height:16px;";
    const tools = document.createElement("div");
    tools.style.cssText = "display:flex;gap:0;align-items:center;";
    const makeTool = (labelText, icon) => {
        const button = document.createElement("button");
        button.type = "button";
        button.title = labelText;
        button.style.cssText = "display:flex;align-items:center;gap:5px;border:1px solid #666;background:#292929;color:#ddd;padding:4px 8px;cursor:pointer;";
        const image = document.createElement("img");
        image.src = new URL(`./icons/${icon}`, import.meta.url).href;
        image.alt = "";
        image.style.cssText = "width:14px;height:14px;filter:invert(1);pointer-events:none;";
        const text = document.createElement("span");
        text.textContent = labelText;
        button.append(image, text);
        return button;
    };
    const freehand = makeTool("自由轮廓", "pencil-simple.svg");
    const rectangle = makeTool("矩形选区", "bounding-box.svg");
    freehand.style.borderRadius = "4px 0 0 4px";
    rectangle.style.cssText += "border-left:0;border-radius:0 4px 4px 0;";
    tools.append(freehand, rectangle);
    const colorRow = document.createElement("div");
    colorRow.style.cssText = "display:flex;align-items:center;gap:6px;font-size:11px;color:#bbb;";
    const colorLabel = document.createElement("span");
    colorLabel.textContent = "标记颜色";
    colorRow.append(colorLabel);
    const markColors = [
        { id: "green", label: "绿", css: "#44d67c" },
        { id: "red", label: "红", css: "#ef5b5b" },
        { id: "blue", label: "蓝", css: "#5b8def" },
        { id: "yellow", label: "黄", css: "#e5c84b" },
        { id: "purple", label: "紫", css: "#b56ce8" },
        { id: "orange", label: "橙", css: "#ef954a" },
    ];
    const colorButtons = new Map();
    for (const item of markColors) {
        const button = document.createElement("button");
        button.type = "button";
        button.title = `标记颜色：${item.label}`;
        button.style.cssText = `width:18px;height:18px;border-radius:50%;border:2px solid #888;background:${item.css};cursor:pointer;padding:0;`;
        colorButtons.set(item.id, button);
        colorRow.append(button);
    }
    const sizeHint = document.createElement("div");
    sizeHint.style.cssText = "font-size:10px;line-height:1.35;color:#d8b76a;";
    sizeHint.textContent = "每种颜色的首个标记决定该组水印档案尺寸；同色后续标记按该尺寸对齐。";
    const stage = document.createElement("div");
    stage.style.cssText = "display:flex;align-items:center;justify-content:center;width:448px;height:280px;max-width:100%;background:#090909;border:1px solid #444;overflow:hidden;box-sizing:border-box;";
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "display:block;cursor:crosshair;touch-action:none;";
    stage.append(canvas);
    const controls = document.createElement("div");
    controls.style.cssText = "display:grid;grid-template-columns:1fr auto;gap:6px;align-items:center;";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "1";
    slider.max = "1";
    slider.value = "1";
    slider.disabled = true;
    const frameLabel = document.createElement("span");
    frameLabel.style.cssText = "min-width:100px;text-align:right;font-size:11px;";
    controls.append(slider, frameLabel);
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:5px;flex-wrap:wrap;";
    const makeButton = (text) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = text;
        button.style.cssText = "border:1px solid #666;border-radius:4px;background:#333;color:#eee;padding:4px 8px;cursor:pointer;";
        return button;
    };
    const undo = makeButton("撤销当前帧");
    const clear = makeButton("清空标记");
    const save = makeButton("保存水印档案");
    actions.append(undo, clear, save);
    root.append(status, tools, colorRow, sizeHint, stage, controls, actions);
    const ctx = canvas.getContext("2d");
    const state = { nodeId: "", promptId: "", clientId: "", sessionId: "", randomSeed: 0, version: 0, frameCount: 1, currentFrame: 1, image: null, layer: "source", draftStrokes: new Map(), activeTool: "rectangle", activeColor: "green", drawing: false, currentStroke: null, dragStart: null, disabled: false, autoQueueAfterLearning: false };
    const draftForFrame = () => state.draftStrokes.get(state.currentFrame) || [];
    const hasDrafts = () => [...state.draftStrokes.values()].some((items) => items.length);
    const regions = () => [...state.draftStrokes.entries()].flatMap(([frame, strokes]) => strokes.map((stroke) => ({ frame: Number(frame) - 1, points: stroke.points, color: stroke.color || "green" })));
    const updateSave = () => {
        const enabled = !state.disabled && hasDrafts();
        save.disabled = !enabled;
        save.style.opacity = enabled ? "1" : ".45";
        save.style.cursor = enabled ? "pointer" : "not-allowed";
    };
    const updateReviewActions = () => {
        for (const button of [freehand, rectangle, undo, clear, save, ...colorButtons.values()]) {
            button.disabled = state.disabled;
            button.style.opacity = state.disabled ? ".55" : "1";
        }
        canvas.style.pointerEvents = state.disabled ? "none" : "auto";
    };
    const draw = () => {
        if (!state.image) return;
        canvas.width = state.image.naturalWidth || 1;
        canvas.height = state.image.naturalHeight || 1;
        ctx.drawImage(state.image, 0, 0, canvas.width, canvas.height);
        ctx.lineWidth = Math.max(2, Math.min(canvas.width, canvas.height) * .006);
        ctx.strokeStyle = "rgba(68,214,124,.96)";
        ctx.fillStyle = "rgba(68,214,124,.20)";
        for (const stroke of draftForFrame()) {
            if (!stroke.points?.length) continue;
            const color = markColors.find((item) => item.id === (stroke.color || "green"))?.css || "#44d67c";
            ctx.strokeStyle = color;
            ctx.fillStyle = `${color}33`;
            ctx.beginPath();
            stroke.points.forEach((item, index) => {
                const x = item[0] * canvas.width;
                const y = item[1] * canvas.height;
                if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            });
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
        }
    };
    const renderLabel = () => { frameLabel.textContent = `F${String(state.currentFrame).padStart(6, "0")} / ${state.frameCount}`; };
    const loadFrame = (frame) => {
        state.currentFrame = Math.max(1, Math.min(state.frameCount, Number(frame) || 1));
        renderLabel();
        if (!state.nodeId) return;
        state.image = new Image();
        state.image.onload = draw;
        state.image.onerror = () => { status.textContent = "预览已失效，请重新执行节点"; };
        state.image.src = previewUrl(state.nodeId, state.promptId, state.clientId, state.currentFrame, state.version, state.layer);
        status.textContent = "在画布上按住鼠标绘制水印档案或字幕轮廓";
    };
    const point = (event) => {
        const rect = canvas.getBoundingClientRect();
        return [Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))];
    };
    const removeCurrent = () => {
        const strokes = draftForFrame().slice(0, -1);
        if (strokes.length) state.draftStrokes.set(state.currentFrame, strokes); else state.draftStrokes.delete(state.currentFrame);
    };
    const finish = (event) => {
        if (!state.currentStroke) return;
        if (state.activeTool === "rectangle") {
            const end = point(event);
            state.currentStroke.points = rectanglePoints(state.dragStart, end);
            if (Math.abs(end[0] - state.dragStart[0]) * canvas.width < 2 || Math.abs(end[1] - state.dragStart[1]) * canvas.height < 2) removeCurrent();
        } else if (state.currentStroke.points.length < 3) removeCurrent();
        else state.currentStroke.points.push([...state.currentStroke.points[0]]);
        state.drawing = false;
        state.currentStroke = null;
        state.dragStart = null;
        updateSave();
        draw();
    };
    const cancel = () => { if (state.currentStroke) { removeCurrent(); state.drawing = false; state.currentStroke = null; state.dragStart = null; updateSave(); draw(); } };
    const setTool = (tool) => {
        state.activeTool = tool;
        const active = tool === "freehand";
        freehand.style.background = active ? "#246b3b" : "#292929";
        rectangle.style.background = active ? "#292929" : "#246b3b";
    };
    const setActiveColor = (color) => {
        state.activeColor = color;
        for (const [id, button] of colorButtons) {
            button.style.borderColor = id === color ? "#ffffff" : "#888";
            button.style.transform = id === color ? "scale(1.16)" : "scale(1)";
        }
    };
    freehand.addEventListener("click", () => setTool("freehand"));
    rectangle.addEventListener("click", () => setTool("rectangle"));
    for (const [id, button] of colorButtons) button.addEventListener("click", () => setActiveColor(id));
    slider.addEventListener("input", () => loadFrame(slider.value));
    canvas.addEventListener("pointerdown", (event) => {
        if (!state.image || state.disabled) return;
        canvas.setPointerCapture(event.pointerId);
        state.drawing = true;
        const start = point(event);
        state.dragStart = state.activeTool === "rectangle" ? start : null;
        state.currentStroke = { points: [start], color: state.activeColor };
        state.draftStrokes.set(state.currentFrame, [...draftForFrame(), state.currentStroke]);
        draw();
    });
    canvas.addEventListener("pointermove", (event) => {
        if (!state.drawing || !state.currentStroke) return;
        state.currentStroke.points = state.activeTool === "rectangle" ? rectanglePoints(state.dragStart, point(event)) : [...state.currentStroke.points, point(event)];
        draw();
    });
    canvas.addEventListener("pointerup", finish);
    canvas.addEventListener("pointercancel", cancel);
    undo.addEventListener("click", () => { removeCurrent(); updateSave(); draw(); });
    clear.addEventListener("click", () => { state.draftStrokes.clear(); status.textContent = "已清空未保存水印"; updateSave(); draw(); });
    save.addEventListener("click", async () => {
        if (save.disabled) return;
        const current = node.__videoWipeProfiles?.selectedItem?.();
        const name = window.prompt(
            "请输入学习水印名称（不改名=补充，改名=新增）",
            current?.name || "",
        );
        if (!name?.trim()) return;
        const payload = buildV2LearnPayload(state.nodeId || node.id, state.promptId, state.clientId || api.clientId, state.sessionId, name, current?.name === name.trim() ? current.id : "", regions(), state.randomSeed);
        save.disabled = true;
        status.textContent = "正在提交学习内容";
        try {
            const response = await requestJson(LEARN_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
            state.sessionId = String(response.session_id || state.sessionId);
            state.promptId = String(response.prompt_id || state.promptId);
            state.clientId = String(response.client_id || state.clientId);
            state.autoQueueAfterLearning = Boolean(response.requires_requeue);
            node.__videoWipeProfiles?.setPending(name.trim());
            state.draftStrokes.clear();
            updateSave();
            status.textContent = state.autoQueueAfterLearning
                ? "标记已提交，学习完成后将自动处理视频"
                : "标记已提交，正在学习并处理视频";
        } catch (error) {
            status.textContent = error.message;
            updateSave();
        }
    });
    const domWidget = node.addDOMWidget("水印轮廓预览", "video_wipe_mask_annotation", root, { serialize: false });
    domWidget.serialize = false;
    let visible = true;
    domWidget.computeSize = () => visible ? [NODE_WIDTH, 450] : [0, -4];
    node.__videoWipeMaskPanel = {
        setVisible(next) { visible = Boolean(next); root.style.display = visible ? "flex" : "none"; node.setDirtyCanvas?.(true, true); },
        hasDrafts: () => hasDrafts(),
        setStatus: (value) => { status.textContent = value; },
        endSession(message = "处理完成") {
            state.layer = "source";
            state.sessionId = "";
            updateReviewActions();
            updateSave();
            if (message) status.textContent = message;
            fitNodeLayout(node);
        },
        setDisabled(disabled) {
            state.disabled = Boolean(disabled);
            for (const item of [freehand, rectangle, slider, undo, clear, save, ...colorButtons.values()]) item.disabled = state.disabled;
            slider.disabled = state.disabled || state.frameCount <= 1;
            canvas.style.pointerEvents = state.disabled ? "none" : "auto";
            root.style.opacity = state.disabled ? ".62" : "1";
            updateReviewActions();
            updateSave();
        },
        takeAutoQueue() {
            const value = state.autoQueueAfterLearning;
            state.autoQueueAfterLearning = false;
            return value;
        },
        updatePreview(preview) {
            state.disabled = false;
            state.layer = "source";
            state.nodeId = String(preview.node_id || node.id || "");
            state.promptId = String(preview.prompt_id || "");
            state.clientId = String(preview.client_id || api.clientId || "");
            state.sessionId = String(preview.session_id || "");
            state.randomSeed = Number(preview.random_seed) || Number(findWidget(node, RANDOM_SEED_WIDGET)?.value) || 0;
            state.version = Number(preview.version) || 0;
            state.frameCount = Math.max(1, Number(preview.frame_count) || 1);
            const layout = previewLayout(preview.width, preview.height);
            stage.style.width = `${layout.viewportWidth}px`;
            stage.style.height = `${layout.viewportHeight}px`;
            canvas.style.width = `${layout.frameWidth}px`;
            canvas.style.height = `${layout.frameHeight}px`;
            slider.max = String(state.frameCount);
            slider.disabled = state.frameCount <= 1;
            updateReviewActions();
            loadFrame(state.currentFrame);
            fitNodeLayout(node);
        },
    };
    setTool("rectangle");
    setActiveColor("green");
    updateSave();
    renderLabel();
    return domWidget;
}

function findNode(nodeId) {
    return graphNodes().find((item) => String(item.id) === String(nodeId));
}

function graphNodes() {
    const graphs = [app.graph, app.rootGraph, app.canvas?.graph].filter(Boolean);
    const nodes = [];
    const seen = new Set();
    for (const graph of graphs) {
        const candidates = [...(graph._nodes || []), ...(graph.nodes || [])];
        for (const node of candidates) {
            if (node && !seen.has(node)) {
                seen.add(node);
                nodes.push(node);
            }
        }
    }
    return nodes;
}

function attachWaitingSession(session, node) {
    if (!session || !node) return;
    session.nodeRef = node;
    node.__videoWipeWaitKey = session.waitKey;
    node.__videoWipeMaskPanel?.updatePreview(session);
    node.__videoWipeMaskPanel?.setStatus("等待绘制并保存水印");
}

function applyWaitingSession(detail) {
    if (!detail?.node_id || !detail?.session_id) return;
    const key = waitSessionKey(detail);
    const node = queuedNodesBySession.get(key) || findNode(detail.node_id);
    queuedNodesBySession.delete(key);
    const session = { ...detail, waitKey: key, nodeRef: null };
    waitingSessions.set(key, session);
    attachWaitingSession(session, node);
}

function createProgressPanel(node) {
    const root = document.createElement("div");
    root.style.cssText = "display:flex;flex-direction:column;gap:5px;padding:6px 4px;box-sizing:border-box;width:100%;";
    const row = document.createElement("div");
    row.style.cssText = "display:flex;justify-content:space-between;gap:8px;font-size:11px;color:#bbb;";
    const stage = document.createElement("span");
    const percent = document.createElement("span");
    stage.textContent = "尚未运行";
    percent.textContent = "0%";
    row.append(stage, percent);
    const track = document.createElement("div");
    track.style.cssText = "height:6px;background:#303030;border:1px solid #505050;border-radius:3px;overflow:hidden;";
    const fill = document.createElement("div");
    fill.style.cssText = "width:0;height:100%;background:#55b86a;transition:width .12s linear;";
    track.append(fill);
    root.append(row, track);
    const widget = node.addDOMWidget("处理进度", "video_wipe_mask_progress", root, { serialize: false });
    widget.serialize = false;
    widget.computeSize = () => [NODE_WIDTH, 54];
    node.__videoWipeProgress = { update(detail) {
        const value = Math.max(0, Math.min(100, Number(detail.percent) || 0));
        stage.textContent = detail.status === "error" ? `失败：${detail.message || "处理异常"}` : detail.stage || "处理中";
        percent.textContent = `${Math.round(value)}%`;
        fill.style.width = `${value}%`;
        fill.style.background = detail.status === "error" ? "#d35a5a" : "#55b86a";
    } };
    return widget;
}

function createDirectionControl(node) {
    const directionWidgets = DIRECTION_WIDGETS.map((name) => findWidget(node, name));
    if (directionWidgets.some((widget) => !widget)) return false;

    const root = document.createElement("div");
    root.style.cssText = "display:flex;flex-direction:column;gap:6px;padding:2px 0;box-sizing:border-box;width:100%;";
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.setAttribute("aria-expanded", "false");
    trigger.style.cssText = "display:flex;align-items:center;justify-content:space-between;width:100%;height:32px;border:1px solid #555;border-radius:4px;background:#292929;color:#eee;padding:0 10px;cursor:pointer;text-align:left;";
    const title = document.createElement("span");
    title.textContent = "扩展方向";
    const arrow = document.createElement("span");
    arrow.textContent = "▾";
    arrow.style.cssText = "color:#aaa;";
    trigger.append(title, arrow);

    const choices = document.createElement("div");
    choices.style.cssText = "display:none;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;padding:8px;border:1px solid #4c4c4c;border-radius:4px;background:#242424;box-sizing:border-box;";
    const inputs = [];
    for (const [index, widget] of directionWidgets.entries()) {
        const option = document.createElement("label");
        option.style.cssText = "display:flex;align-items:center;gap:7px;min-width:0;padding:5px 6px;border-radius:3px;background:#2c2c2c;color:#ddd;font-size:12px;cursor:pointer;";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = Boolean(widget.value);
        input.style.cssText = "margin:0;accent-color:#55b86a;";
        const text = document.createElement("span");
        text.textContent = DIRECTION_WIDGETS[index];
        input.addEventListener("change", () => {
            widget.value = input.checked;
            node.setDirtyCanvas?.(true, true);
            setOpen(false);
        });
        option.append(input, text);
        choices.append(option);
        inputs.push({ input, widget });
    }

    const setOpen = (open) => {
        const expanded = Boolean(open);
        choices.style.display = expanded ? "grid" : "none";
        arrow.textContent = expanded ? "▴" : "▾";
        trigger.setAttribute("aria-expanded", String(expanded));
        fitNodeLayout(node);
    };
    const sync = () => {
        for (const { input, widget } of inputs) input.checked = Boolean(widget.value);
    };
    trigger.addEventListener("click", () => setOpen(choices.style.display === "none"));
    root.addEventListener("pointerdown", (event) => event.stopPropagation());
    root.append(trigger, choices);

    const directionWidget = node.addDOMWidget("扩展方向", "video_wipe_mask_directions", root, { serialize: false });
    directionWidget.serialize = false;
    directionWidget.computeSize = () => [NODE_WIDTH, choices.style.display === "grid" ? 102 : 38];
    const firstIndex = node.widgets?.indexOf(directionWidgets[0]) ?? -1;
    const currentIndex = node.widgets?.indexOf(directionWidget) ?? -1;
    if (firstIndex >= 0 && currentIndex >= 0 && currentIndex !== firstIndex) {
        node.widgets.splice(currentIndex, 1);
        node.widgets.splice(firstIndex, 0, directionWidget);
    }
    for (const widget of directionWidgets) hideWidget(widget);
    node.__videoWipeDirections = { sync, setOpen };
    node.__videoWipeSyncDirections = sync;
    setOpen(false);
    return true;
}

function applyModuleLabels(node) {
    for (const [name, label] of MODULE_LABELS) {
        const widget = findWidget(node, name);
        if (widget) widget.label = label;
    }
}

function createModuleHeader(node, title, anchor) {
    const root = document.createElement("div");
    root.style.cssText = "display:flex;align-items:center;gap:6px;padding:2px 6px;font-size:12px;font-weight:600;color:#c9d6e4;";
    const bar = document.createElement("span");
    bar.style.cssText = "flex:0 0 3px;height:12px;border-radius:2px;background:#4a9eff;";
    const text = document.createElement("span");
    text.textContent = title;
    root.append(bar, text);
    const widget = node.addDOMWidget(`版块 ${title}`, "video_wipe_mask_section", root, {
        serialize: false,
    });
    widget.serialize = false;
    widget.computeSize = () => [NODE_WIDTH, 22];
    const widgets = node.widgets || [];
    const target = anchor ? widgets.indexOf(anchor) : -1;
    const current = widgets.indexOf(widget);
    if (target >= 0 && current >= 0) {
        widgets.splice(current, 1);
        widgets.splice(target, 0, widget);
    }
    return widget;
}

function createModuleSections(node) {
    if (node.__videoWipeSectionsBound) return true;
    if (!isVideoWipeMaskNode(node)) return false;
    let created = 0;
    for (const section of MODULE_SECTIONS) {
        const anchor = findWidget(node, section.anchor);
        if (!anchor) continue;
        createModuleHeader(node, section.title, anchor);
        created += 1;
    }
    if (!created) return false;
    node.__videoWipeSectionsBound = true;
    return true;
}

function bindModeWidgets(node) {
    if (node.__videoWipeModesBound) return true;
    const textMode = findWidget(node, TEXT_MODE_WIDGET);
    const watermarkMode = findWidget(node, WATERMARK_MODE_WIDGET);
    const textWatermarkMode = findWidget(node, TEXT_WATERMARK_MODE_WIDGET);
    const textWatermarkInput = findWidget(node, TEXT_WATERMARK_TEXT_WIDGET);
    const textQuery = findWidget(node, "检测指定文字");
    const textThreshold = findWidget(node, "文字检测阈值");
    const watermarkThreshold = findWidget(node, "水印检测阈值");
    if (!textMode || !watermarkMode || !textWatermarkMode || !textWatermarkInput || !textQuery
        || !textThreshold || !watermarkThreshold) {
        return false;
    }
    applyModuleLabels(node);
    createModuleSections(node);
    const enforceModes = () => {
        // 工作流的值还没恢复完成时不要写回，否则会把用户保存的开关覆盖成默认值。
        if (typeof textMode.value !== "boolean" || typeof watermarkMode.value !== "boolean") {
            return;
        }
        const modes = normalizeModes(textMode.value, watermarkMode.value);
        const textEnabled = modes.textMode ?? Boolean(textMode.value);
        const watermarkEnabled =
            modes.watermarkMode ?? modes.markMode ?? Boolean(watermarkMode.value);
        textMode.value = textEnabled;
        watermarkMode.value = watermarkEnabled;
        setWidgetDisabled(textMode, false);
        setWidgetDisabled(watermarkMode, false);
        const textWatermarkEnabled = Boolean(textWatermarkMode.value);
        setWidgetDisabled(textQuery, !textEnabled);
        setWidgetDisabled(textThreshold, !textEnabled);
        setWidgetDisabled(textWatermarkInput, !textWatermarkEnabled);
        setWidgetDisabled(watermarkThreshold, !watermarkEnabled);
        const watermarkProfileNeeded = watermarkEnabled || textWatermarkEnabled;
        node.__videoWipeProfiles?.setVisible(watermarkProfileNeeded);
        node.__videoWipeMaskPanel?.setVisible(watermarkProfileNeeded);
        fitNodeLayout(node);
    };
    for (const widget of [textMode, watermarkMode, textWatermarkMode]) {
        const original = widget.callback;
        widget.callback = function () {
            const result = original?.apply(this, arguments);
            enforceModes();
            return result;
        };
    }
    node.__videoWipeModesBound = true;
    node.__videoWipeEnforceModes = enforceModes;
    enforceModes();
    return true;
}

function isVideoWipeMaskNode(node) {
    return node?.type === NODE_CLASS
        || node?.comfyClass === NODE_CLASS
        || node?.constructor?.type === NODE_CLASS
        || node?.constructor?.comfyClass === NODE_CLASS;
}

function finalizeNodeControls(node) {
    // 绝不移动控件位置：ComfyUI 按位置恢复工作流的值，一旦插入或移动控件，
    // 后面的值就会错位一格，表现就是"重启后设置被重置"。
    if (!isVideoWipeMaskNode(node)) return;
    ensureNativeSeedControl(node);
    node.__videoWipeSyncDirections?.();
    node.__videoWipeEnforceModes?.();
}

function decorateNode(node) {
    if (!isVideoWipeMaskNode(node)) return;
    bindWidgetValueSerialization(node);
    setTimeout(() => finalizeNodeControls(node), 0);
    if (node.__videoWipeV2Decorated) return;
    hideWidget(findWidget(node, WATERMARK_DATA_WIDGET));
    hideWidget(findWidget(node, WATERMARK_PROFILE_WIDGET));
    if (!node.__videoWipeDirections) createDirectionControl(node);
    if (!node.__videoWipeProfiles) createProfileControl(node);
    if (!node.__videoWipeProgress) createProgressPanel(node);
    if (!node.__videoWipeMaskPanel) createPanel(node);
    createModuleSections(node);
    const modesBound = bindModeWidgets(node);
    if (!modesBound) return;
    const session = [...waitingSessions.values()].find((item) => !item.nodeRef && item.node_id === String(node.id));
    if (session) attachWaitingSession(session, node);
    node.__videoWipeV2Decorated = true;
    fitNodeLayout(node);
}

function decorateExistingNodes() {
    for (const node of graphNodes()) {
        decorateNode(node);
        finalizeNodeControls(node);
    }
}

function scheduleDecorateExistingNodes() {
    decorateExistingNodes();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(decorateExistingNodes);
    setTimeout(decorateExistingNodes, 0);
    setTimeout(decorateExistingNodes, 250);
}

app.registerExtension({
    name: "VideoWipeMask.V2",
    nodeCreated(node) {
        decorateNode(node);
    },
    async setup() {
        scheduleDecorateExistingNodes();
        if (!api.__videoWipeMaskV2Setup) {
            const originalQueuePrompt = api.queuePrompt;
            api.queuePrompt = async function () {
                const promptData = arguments[1];
                const queued = interactiveWaitNodeIds(promptData?.output, NODE_CLASS)
                    .map((nodeId) => [nodeId, findNode(nodeId)])
                    .filter(([, node]) => Boolean(node));
                const response = await originalQueuePrompt.apply(this, arguments);
                if (response?.prompt_id) {
                    const promptId = String(response.prompt_id);
                    queued.forEach(([nodeId, node]) => queuedNodesBySession.set(`${promptId}:${nodeId}`, node));
                }
                return response;
            };
            api.addEventListener("videowipemask.v2.progress", async ({ detail }) => {
                for (const node of graphNodes()) {
                    if (!progressMatchesNode(node.id, detail)) continue;
                    node.__videoWipeProgress?.update(detail);
                    if (detail.status === "error") {
                        node.__videoWipeMaskPanel?.setStatus(`处理失败：${detail.message || "处理异常"}`);
                        void node.__videoWipeProfiles?.refresh?.();
                    } else if (detail.status === "complete") {
                        const refresh = node.__videoWipeProfiles?.refresh?.(
                            detail.selected_id || detail.profile_name,
                        );
                        if (node.__videoWipeMaskPanel?.takeAutoQueue?.()) {
                            await refresh;
                            node.__videoWipeMaskPanel?.setStatus("标记已就绪，正在自动处理视频");
                            try {
                                await app.queuePrompt(0);
                            } catch (error) {
                                node.__videoWipeMaskPanel?.setStatus(
                                    `自动处理失败：${error.message || "请手动运行"}`,
                                );
                            }
                        } else {
                            node.__videoWipeMaskPanel?.setStatus("学习完成，可继续在预览中标记并保存");
                            void refresh;
                        }
                    } else if (detail.stage) {
                        const percent = Math.round(Number(detail.percent) || 0);
                        node.__videoWipeMaskPanel?.setStatus(`${detail.stage} ${percent}%`);
                    }
                }
            });
            api.addEventListener(WAITING_EVENT, ({ detail }) => applyWaitingSession(detail));
            api.addEventListener(MODE_REQUIRED_EVENT, ({ detail }) => {
                void handleModeRequired(detail);
            });
            api.addEventListener(PREVIEW_READY_EVENT, ({ detail }) => {
                const node = findNode(detail?.node_id);
                if (!node) return;
                node.__videoWipeMaskPanel?.updatePreview(detail);
                node.__videoWipeMaskPanel?.setStatus("已缓存当前帧，可直接在预览中标记并保存");
                void node.__videoWipeProfiles?.refresh?.();
            });
            api.addEventListener("reconnected", () => decorateExistingNodes());
            api.__videoWipeMaskV2Setup = true;
        }
        scheduleDecorateExistingNodes();
    },
    afterConfigureGraph() {
        scheduleDecorateExistingNodes();
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_CLASS) return;
        const originalCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = originalCreated?.apply(this, arguments);
            decorateNode(this);
            return result;
        };
    },
});
