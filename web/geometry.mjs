export function normalizeModes(textMode, watermarkMode) {
    return {
        textMode: Boolean(textMode),
        watermarkMode: Boolean(watermarkMode),
    };
}

export function previewLayout(width, height, viewportWidth = 448, viewportHeight = 280) {
    const sourceWidth = Math.max(1, Number(width) || 1);
    const sourceHeight = Math.max(1, Number(height) || 1);
    const scale = Math.min(viewportWidth / sourceWidth, viewportHeight / sourceHeight);
    return {
        viewportWidth,
        viewportHeight,
        frameWidth: Math.round(sourceWidth * scale),
        frameHeight: Math.round(sourceHeight * scale),
        widgetHeight: 412,
    };
}

export function defaultLearningSelection(items, currentId) {
    const ready = (item) => Boolean(item?.stable_ready);
    if (items.some((item) => item.id === currentId && ready(item))) return currentId;
    return items.find(ready)?.id || "";
}

export function learningMenuHeight(itemCount, open, hasMessage) {
    const base = hasMessage ? 62 : 44;
    return open ? base + Math.max(0, Number(itemCount) || 0) * 38 : base;
}

export function buildV2LearnPayload(
    nodeId,
    promptId,
    clientId,
    sessionId,
    name,
    selectedId,
    regions,
    randomSeed,
) {
    return {
        node_id: String(nodeId || ""),
        prompt_id: String(promptId || ""),
        client_id: String(clientId || ""),
        session_id: String(sessionId || ""),
        name: String(name || "").trim(),
        selected_id: String(selectedId || ""),
        regions: Array.isArray(regions) ? regions : [],
        random_seed: Number.isFinite(Number(randomSeed)) ? Math.max(0, Number(randomSeed)) : 0,
    };
}

export function waitSessionKey(detail) {
    return `${String(detail?.prompt_id || "")}:${String(detail?.node_id || "")}`;
}

export function interactiveWaitNodeIds(output, nodeClass) {
    return Object.entries(output || {})
        .filter(([, value]) => value?.class_type === nodeClass)
        .filter(([, value]) => value.inputs?.["水印检测"] !== false)
        .filter(([, value]) => !String(value.inputs?.["当前水印档案"] || "").trim())
        .map(([nodeId]) => String(nodeId));
}

export function rectanglePoints(start, end) {
    return [
        start,
        [end[0], start[1]],
        end,
        [start[0], end[1]],
        start,
    ];
}

export function progressMatchesNode(nodeId, detail) {
    return detail?.node_id !== undefined && String(nodeId) === String(detail.node_id);
}
