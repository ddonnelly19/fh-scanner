const element = (id) => document.getElementById(id);
let data;
let state;
let preview;
let activeSource;
let chosenId = null;
let saving = false;
let polling = false;
const normalize = (value) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
const blocked = () => saving || state?.locked;

function notify(text, error = false) {
	element("message").textContent = text;
	element("message").classList.toggle("error", error);
}

async function api(path, input) {
	const response = await fetch(path, input === undefined ? {} : {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Review-Token": document.querySelector('meta[name="review-token"]').content },
		body: JSON.stringify({ ...input, revision: state?.revision }),
	});
	if (!response.ok) throw new Error(await response.text());
	return response.json();
}

function queueItems() {
	if (!data) return [];
	const filter = element("filter").value;
	const query = normalize(element("queue-search").value);
	return data.items.filter((item) => {
		const include = filter === "all" ||
			(filter === "manual" ? item.manual :
				filter === "unresolved" ? item.ownership === "owned" && item.selectedId === null :
					item.ownership === filter);
		return include && normalize(`${item.name ?? ""} ${item.text} ${item.source}`).includes(query);
	});
}

function renderReview() {
	element("run").textContent = `${state.label} / ${state.directory}`;
	element("summary").textContent = data
		? `${data.ownedCount} unique cars in plan / ${data.items.filter((item) => item.ownership === "owned" && !item.selectedId).length} owned tiles to resolve / ${data.unknownCount} unknown-ownership tiles excluded`
		: "Review inputs unavailable. Use the workflow controls above.";
	const items = queueItems();
	if (!items.some((item) => item.source === activeSource)) activeSource = items[0]?.source;
	element("queue-count").textContent = `${items.length} captured tiles`;
	element("queue").replaceChildren(...items.map((item) => {
		const button = document.createElement("button");
		button.className = `queue-item${item.source === activeSource ? " active" : ""}`;
		button.textContent = item.name ?? "Unparseable name - inspect tile";
		const small = document.createElement("small");
		small.textContent = `${item.ownership}${item.ownershipOverride ? " (reviewed)" : ""} / ${item.manual ? "Manual" : item.selectedId ? "Matched" : "Needs match"} / ${item.source}`;
		button.append(small);
		button.disabled = Boolean(blocked());
		button.onclick = () => { activeSource = item.source; element("catalog-search").value = ""; renderReview(); };
		return button;
	}));
	const car = items.find((item) => item.source === activeSource);
	element("detail").hidden = !car;
	element("empty").hidden = Boolean(car);
	if (!car) return;
	chosenId = null;
	element("position").textContent = `${items.indexOf(car) + 1} of ${items.length}`;
	element("car-name").textContent = car.name ?? "Unparseable OCR - choose from the tile";
	element("source").textContent = car.source;
	element("tile").src = `/tile?source=${encodeURIComponent(car.source)}`;
	element("ocr").textContent = car.text;
	element("ownership").textContent = `OCR classification: ${car.ocrOwnership}\n${car.labelText}`;
	element("ownership-select").value = car.ownership;
	element("ownership-verified").checked = false;
	element("ownership-reset").disabled = !car.ownershipOverride || Boolean(blocked());
	element("ownership-save").disabled = Boolean(blocked());
	element("reason").textContent = car.reason;
	const current = data.catalog.find((candidate) => candidate.id === car.selectedId);
	element("current").textContent = current ? `${car.manual ? "Manual match" : "Current match"}: ${current.name} (${current.id})` :
		car.ownership !== "owned" ? "Excluded from plan until ownership is verified as owned." : "No confirmed site match.";
	element("reset").disabled = !car.manual || car.ownership !== "owned" || Boolean(blocked());
	renderCandidates();
}

function renderCandidates() {
	const car = data?.items.find((item) => item.source === activeSource);
	if (!car) return;
	const query = normalize(element("catalog-search").value).trim().split(/\s+/).filter(Boolean);
	const candidates = data.catalog.filter((candidate) => query.every((word) => normalize(`${candidate.name} ${candidate.id}`).includes(word)))
		.sort((a, b) => Number(car.suggestions.includes(b.id)) - Number(car.suggestions.includes(a.id)) || a.name.localeCompare(b.name));
	element("results-count").textContent = `${candidates.length} catalog cars${query.length ? "" : " - suggestions first"}`;
	element("candidates").replaceChildren(...candidates.map((candidate) => {
		const label = document.createElement("label");
		label.className = "candidate";
		const radio = document.createElement("input");
		radio.type = "radio"; radio.name = "candidate"; radio.value = candidate.id;
		radio.checked = chosenId === candidate.id;
		radio.disabled = Boolean(blocked()) || car.ownership !== "owned";
		radio.onchange = () => { chosenId = candidate.id; element("save").disabled = Boolean(blocked()); };
		const text = document.createElement("span");
		text.textContent = candidate.name;
		const small = document.createElement("small");
		small.textContent = `${candidate.id}${car.suggestions.includes(candidate.id) ? " / Suggested - verify before saving" : ""}`;
		text.append(small); label.append(radio, text);
		return label;
	}));
	element("save").disabled = Boolean(blocked()) || car.ownership !== "owned" || chosenId === null || !candidates.some((item) => item.id === chosenId);
}

function fillOptions(id, items, selected) {
	element(id).replaceChildren(...items.map((item) => {
		const option = document.createElement("option");
		option.value = item.id; option.textContent = item.label; option.selected = item.id === selected;
		return option;
	}));
}

function renderWorkflow(updateSelection = false) {
	if (updateSelection) {
		fillOptions("run-select", state.runs, state.directory);
		fillOptions("site-select", state.sites, state.site);
	}
	for (const id of ["select-run", "refresh", "job-match", "job-ownership", "run-select", "site-select"]) element(id).disabled = Boolean(blocked());
	for (const id of ["regenerate", "preview"]) element(id).disabled = Boolean(blocked()) || !data;
	element("workflow-error").textContent = state.reviewError;
	element("job-status").textContent = state.job.kind ? `${state.job.kind}: ${state.job.state}${state.job.error ? ` - ${state.job.error}` : ""}` : "Job progress";
	element("job-log").textContent = state.job.log;
	if (state.job.state === "running" || state.job.state === "failed") element("job-panel").open = true;
	element("sync-panel").hidden = state.sync.state === "idle";
	element("sync-instructions").textContent = state.sync.instructions;
	element("sync-status").textContent = `${state.sync.state}: ${state.sync.confirmed} / ${state.sync.total} confirmed${state.sync.error ? ` - ${state.sync.error}` : ""}`;
	element("sync-confirm-panel").hidden = state.sync.state !== "ready";
	element("sync-confirm-label").textContent = `Type APPLY ${state.sync.total} to mark these cars owned (no removals)`;
	element("sync-confirm").disabled = saving || state.sync.state !== "ready";
	element("sync-close").disabled = saving || ["opening", "applying"].includes(state.sync.state);
	element("sync-result").textContent = state.sync.resultPath ? `Audit saved: ${state.sync.resultPath}` : "";
	element("sync-share").hidden = !state.sync.shareUrl;
	if (state.sync.shareUrl) element("sync-share").href = state.sync.shareUrl;
	element("sync-open").disabled = Boolean(blocked()) || !preview?.cars.length;
	for (const id of ["filter", "queue-search", "catalog-search", "skip", "ownership-select", "ownership-verified"]) element(id).disabled = Boolean(blocked());
	if (blocked()) {
		for (const id of ["save", "reset", "ownership-save", "ownership-reset"]) element(id).disabled = true;
		element("queue").querySelectorAll("button").forEach((button) => { button.disabled = true; });
		element("candidates").querySelectorAll("input").forEach((input) => { input.disabled = true; });
	}
}

async function loadReview() {
	data = undefined;
	if (!state.reviewError) data = await api("/api/review");
	renderReview();
}

function invalidatePreview() {
	preview = undefined; element("plan-panel").hidden = true;
}

async function action(path, input, message, advance = false) {
	if (saving) return;
	const items = queueItems();
	const next = items[items.findIndex((item) => item.source === activeSource) + 1]?.source;
	saving = true; renderWorkflow();
	try {
		state = await api(path, input);
		if (!path.startsWith("/api/sync/")) {
			invalidatePreview();
			if (advance && next) activeSource = next;
			element("catalog-search").value = "";
			await loadReview();
		}
		if (path === "/api/sync/close") invalidatePreview();
		notify(message);
	} catch (error) {
		notify(`${error.message} Check local files or the destination before retrying.`, true);
		try { state = await api("/api/state"); await loadReview(); } catch (refreshError) { notify(`Reload failed: ${refreshError.message}`, true); }
	} finally {
		saving = false;
		renderReview(); renderWorkflow(path === "/api/select" || path === "/api/refresh");
	}
}

element("filter").onchange = () => { activeSource = undefined; renderReview(); };
element("queue-search").oninput = renderReview;
element("catalog-search").oninput = renderCandidates;
element("save").onclick = () => { if (chosenId !== null) void action("/api/match", { source: activeSource, id: chosenId }, "Match saved. Owned plan regenerated.", true); };
element("reset").onclick = () => { void action("/api/match", { source: activeSource, id: null }, "Manual match removed. Plan regenerated."); };
element("ownership-save").onclick = () => {
	if (!element("ownership-verified").checked) { notify("Inspect the tile and check the ownership verification box first.", true); return; }
	void action("/api/ownership", { source: activeSource, status: element("ownership-select").value, verified: true }, "Ownership correction saved. Plan regenerated.");
};
element("ownership-reset").onclick = () => { void action("/api/ownership", { source: activeSource, status: null }, "OCR classification restored. Plan regenerated."); };
element("skip").onclick = () => {
	const items = queueItems();
	const index = items.findIndex((item) => item.source === activeSource);
	activeSource = items[(index + 1) % items.length]?.source;
	element("catalog-search").value = ""; renderReview();
};
element("tile").onerror = () => notify("Captured tile could not be loaded. Check that the saved PNG still exists.", true);
element("select-run").onclick = () => { activeSource = undefined; void action("/api/select", { run: element("run-select").value, site: element("site-select").value }, "Saved run loaded."); };
element("refresh").onclick = () => { void action("/api/refresh", {}, "Local inputs reloaded."); };
element("job-match").onclick = () => { void action("/api/job", { kind: "match" }, "Catalog refresh and name matching started. Watch the job log."); };
element("job-ownership").onclick = () => { void action("/api/job", { kind: "ownership" }, "Ownership OCR started. Manual corrections are preserved."); };
element("regenerate").onclick = () => { void action("/api/regenerate", {}, "Owned plan regenerated from current evidence and manual matches."); };
element("preview").onclick = async () => {
	try {
		preview = await api("/api/plan");
		element("plan-summary").textContent = `${state.label}: ${preview.cars.length} unique additions / ${preview.review.length} excluded review entries. Inspect every car before applying.`;
		element("plan-cars").replaceChildren(...preview.cars.map((car) => {
			const row = document.createElement("div"); row.className = "plan-car"; row.textContent = `${car.name} / ${car.id} / ${car.sources.length} tile(s)`; return row;
		}));
		element("plan-review").textContent = preview.review.join("\n");
		element("plan-panel").hidden = false; renderWorkflow();
	} catch (error) { notify(`Preview failed: ${error.message}`, true); }
};
element("sync-open").onclick = () => {
	element("destination-checked").checked = false; element("sync-confirmation").value = "";
	if (preview) void action("/api/sync/open", { hash: preview.hash }, "Edge is open. Verify login/starting collection there, then confirm here.");
};
element("sync-confirm").onclick = () => { void action("/api/sync/confirm", {
	confirmation: element("sync-confirmation").value, destinationChecked: element("destination-checked").checked,
}, "Sync started. Updates are sequential; do not close Edge while applying."); };
element("sync-close").onclick = () => { void action("/api/sync/close", {}, "Sync browser closed."); };

async function poll() {
	if (!state || saving || polling) return;
	polling = true;
	try {
		const next = await api("/api/state");
		if (saving) return;
		const changed = next.revision !== state.revision;
		const jobDone = state.job.state === "running" && next.job.state !== "running";
		const unlocked = state.locked && !next.locked;
		state = next;
		if (changed || jobDone || unlocked) { invalidatePreview(); await loadReview(); }
		renderWorkflow(changed);
	} catch (error) { notify(`Dashboard connection failed: ${error.message}`, true); }
	finally { polling = false; }
}

async function initialize() {
	try {
		state = await api("/api/state"); await loadReview(); renderWorkflow(true);
		notify("Review tiles and save changes locally. Tracker updates require plan preview and explicit confirmation.");
	} catch (error) { notify(`Cannot load dashboard: ${error.message}`, true); }
}
void initialize();
setInterval(() => { void poll(); }, 2000);
