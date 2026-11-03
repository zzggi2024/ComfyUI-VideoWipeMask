import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_CLASS_NAME = "LZ_SmartVideoSplit";
const PROGRESS_WIDGET_NAMES = ["当前段", "总段数", "缓存段数"];
const CLEAR_CACHE_ENDPOINT = "/videowipemask/split/clear-cache";
const TASK_WIDGET_NAME = "任务名";
const CACHE_COUNT_WIDGET_NAME = "缓存段数";
const REUSE_WIDGET_NAME = "复用缓存";

function createClearCacheButton(node) {
	if (node.__videoWipeClearCacheBound) return;
	const widgets = node.widgets || [];
	const root = document.createElement("div");
	root.style.cssText = "display:flex;align-items:center;gap:8px;width:100%;";
	const button = document.createElement("button");
	button.textContent = "清空缓存";
	button.title = "删除该任务名下的全部段落缓存";
	button.style.cssText = "flex:1;height:22px;border:1px solid #4a5a6a;border-radius:4px;background:#2a323c;color:#dfe7ef;font-size:12px;cursor:pointer;";
	const status = document.createElement("span");
	status.style.cssText = "font-size:11px;color:#8fa3b5;white-space:nowrap;";
	root.append(button, status);
	button.addEventListener("click", async () => {
		const task = String(findWidget(node, TASK_WIDGET_NAME)?.value ?? "").trim();
		button.disabled = true;
		status.textContent = "清空中…";
		try {
			const response = await api.fetchApi(CLEAR_CACHE_ENDPOINT, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ task }),
			});
			const data = await response.json();
			status.textContent = `已清空 ${Number(data?.removed ?? 0)} 份缓存`;
			const counter = findWidget(node, CACHE_COUNT_WIDGET_NAME);
			if (counter) {
				lockProgressWidgetValue(counter, 0);
				counter.callback?.(0);
			}
			node.setDirtyCanvas?.(true, true);
		} catch (error) {
			status.textContent = "清空失败";
		} finally {
			button.disabled = false;
		}
	});
	const widget = node.addDOMWidget("清空缓存按钮", "video_wipe_mask_cache_button", root, {
		serialize: false,
	});
	widget.serialize = false;
	widget.computeSize = () => [node.size?.[0] || 300, 26];
	const index = widgets.indexOf(findWidget(node, REUSE_WIDGET_NAME));
	const current = widgets.indexOf(widget);
	if (index >= 0 && current >= 0) {
		widgets.splice(current, 1);
		widgets.splice(index + 1, 0, widget);
	}
	node.__videoWipeClearCacheBound = true;
}

function findWidget(node, widgetName) {
	return node?.widgets?.find((item) => item?.name === widgetName);
}

function lockProgressWidgetValue(widget, value) {
	widget.options = widget.options || {};
	widget.options.readOnly = true;
	widget.options.min = value;
	widget.options.max = value;
	widget.value = value;
}

function setWidgetValue(nodeId, widgetName, value) {
	const node = app?.graph?._nodes_by_id?.[String(nodeId)];
	const widget = findWidget(node, widgetName);
	if (!widget) {
		return;
	}
	if (PROGRESS_WIDGET_NAMES.includes(widgetName)) {
		lockProgressWidgetValue(widget, value);
	} else {
		widget.value = value;
	}
	widget.callback?.(value);
	node.setDirtyCanvas?.(true, true);
}

function configureProgressWidgets(node) {
	for (const widgetName of PROGRESS_WIDGET_NAMES) {
		const widget = findWidget(node, widgetName);
		if (!widget) {
			continue;
		}
		lockProgressWidgetValue(widget, Number(widget.value ?? 0));
	}
}

function resetProgressWidgets(node) {
	for (const widgetName of PROGRESS_WIDGET_NAMES) {
		const widget = findWidget(node, widgetName);
		if (!widget) {
			continue;
		}
		lockProgressWidgetValue(widget, 0);
		widget.callback?.(0);
	}
	node?.setDirtyCanvas?.(true, true);
}

function resetAllProgressWidgets() {
	for (const node of app?.graph?._nodes || []) {
		if (node?.comfyClass === NODE_CLASS_NAME || node?.type === NODE_CLASS_NAME) {
			resetProgressWidgets(node);
		}
	}
}

app.registerExtension({
	name: "videowipemask.smart_video_serial",
	setup() {
		api.addEventListener("shaobkj.smart_video.feedback", (event) => {
			const detail = event?.detail;
			setWidgetValue(detail?.node_id, detail?.widget_name, detail?.value);
		});
		api.addEventListener("promptQueueing", resetAllProgressWidgets);
	},
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_CLASS_NAME) {
			return;
		}
		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const result = originalOnNodeCreated
				? originalOnNodeCreated.apply(this, arguments)
				: undefined;
			configureProgressWidgets(this);
			createClearCacheButton(this);
			return result;
		};
	},
});
