const DEFAULT_VIEW = "list";
const WORK_ITEM_STATUSES = ["new", "backlog", "implementing", "done"];

const config = normalizeConfig(window.AGILE_WORKSPACE_CONFIG || {});
const auth = createAuthClient(config);

const state = {
  session: null,
  projects: [],
  selectedProjectId: null,
  selectedItemId: null,
  projectDetails: {},
  projectDraft: null,
  itemDraft: null,
  serviceKeys: [],
  serviceKeyDraft: buildBlankServiceKeyDraft(),
  createdServiceKey: null,
  activeView: DEFAULT_VIEW,
  workspaceNotice: { message: "", tone: "" },
  serviceKeyNotice: { message: "", tone: "" },
  viewport: getViewportCategory(),
  navDrawerOpen: false,
  detailPaneOpen: false,
};

const elements = {
  authGate: document.querySelector("#auth-gate"),
  authStatus: document.querySelector("#auth-status"),
  portalShell: document.querySelector("#portal-shell"),
  signInButton: document.querySelector("#sign-in-button"),
  signOutButton: document.querySelector("#sign-out-button"),
  refreshButton: document.querySelector("#refresh-button"),
  statusBanner: document.querySelector("#status-banner"),
  brandTitle: document.querySelector("#brand-title"),
  brandSubtitle: document.querySelector("#brand-subtitle"),
  sessionRole: document.querySelector("#session-role"),
  sessionName: document.querySelector("#session-name"),
  sessionEmail: document.querySelector("#session-email"),
  pageTitle: document.querySelector("#page-title"),
  pageSubtitle: document.querySelector("#page-subtitle"),
  navToggleButton: document.querySelector("#nav-toggle-button"),
  navCloseButton: document.querySelector("#nav-close-button"),
  projectCreateButton: document.querySelector("#project-create-button"),
  projectList: document.querySelector("#project-list"),
  viewSwitcher: document.querySelector("#view-switcher"),
  projectSummaryStrip: document.querySelector("#project-summary-strip"),
  workspaceView: document.querySelector("#workspace-view"),
  detailPane: document.querySelector("#detail-pane"),
  shellBackdrop: document.querySelector("#shell-backdrop"),
  itemCreateActions: document.querySelector("#item-create-actions"),
  itemCreateEpic: document.querySelector("#item-create-epic"),
  itemCreateStory: document.querySelector("#item-create-story"),
  itemCreateTask: document.querySelector("#item-create-task"),
};

elements.signInButton.addEventListener("click", async () => {
  try {
    await auth.beginSignIn();
  } catch (error) {
    console.error(error);
    showAuthGate(error.message || "Could not start sign-in.");
  }
});

elements.signOutButton.addEventListener("click", async () => {
  try {
    await auth.signOut();
  } catch (error) {
    console.error(error);
  } finally {
    showAuthGate("You have been signed out.");
  }
});

elements.refreshButton.addEventListener("click", async () => {
  await refreshWorkspace({ forceProjectDetail: true });
});

elements.projectCreateButton.addEventListener("click", () => {
  beginCreateProject();
});

elements.itemCreateEpic.addEventListener("click", () => {
  beginCreateItem("epic");
});

elements.itemCreateStory.addEventListener("click", () => {
  beginCreateItem("story");
});

elements.itemCreateTask.addEventListener("click", () => {
  beginCreateItem("task");
});

elements.navToggleButton.addEventListener("click", () => {
  toggleNavigationDrawer();
});

elements.navCloseButton.addEventListener("click", () => {
  closeNavigationDrawer();
});

elements.shellBackdrop.addEventListener("click", () => {
  closeOverlays();
});

elements.projectList.addEventListener("click", handleProjectListClick);
elements.viewSwitcher.addEventListener("click", handleViewSwitchClick);
elements.workspaceView.addEventListener("click", handleWorkspaceViewClick);
elements.workspaceView.addEventListener("input", handleWorkspaceViewInput);
elements.workspaceView.addEventListener("change", handleWorkspaceViewInput);
elements.detailPane.addEventListener("click", handleDetailPaneClick);
elements.detailPane.addEventListener("input", handleDetailPaneInput);
elements.detailPane.addEventListener("change", handleDetailPaneInput);
window.addEventListener("resize", handleViewportResize);

void initialize();

async function initialize() {
  setBanner("Checking workspace session...");

  try {
    const authState = await withTimeout(
      auth.initialize(),
      12000,
      "Workspace sign-in check timed out. Please refresh and try again.",
    );
    if (!authState.authenticated) {
      showAuthGate("Sign in to open the agile workspace.");
      return;
    }

    const sessionPayload = await withTimeout(
      apiRequest("/api/session"),
      12000,
      "Workspace session check timed out. Please refresh and sign in again.",
    );

    state.session = sessionPayload.session;
    state.serviceKeyDraft = buildBlankServiceKeyDraft();

    showPortal();
    renderAll();
    await refreshWorkspace({ preserveSelection: true });
  } catch (error) {
    console.error(error);
    showAuthGate(error.message || "Could not open the workspace.");
  }
}

async function refreshWorkspace(options = {}) {
  const { preserveSelection = true, forceProjectDetail = false } = options;
  setBanner("Refreshing workspace data...");
  elements.refreshButton.disabled = true;

  try {
    await loadProjects({ preserveSelection });
    if (state.session?.permissions?.agileManage) {
      await loadServiceKeys();
    } else {
      state.serviceKeys = [];
      state.serviceKeyDraft = buildBlankServiceKeyDraft();
      state.createdServiceKey = null;
    }
    if (state.selectedProjectId) {
      await loadProjectDetail(state.selectedProjectId, { force: forceProjectDetail });
    }
    renderAll();
    setBanner(`Loaded ${state.projects.length} agile project${state.projects.length === 1 ? "" : "s"} from AWS.`);
  } catch (error) {
    console.error(error);
    setBanner(error.message || "Could not refresh the workspace.");
  } finally {
    elements.refreshButton.disabled = false;
  }
}

async function loadProjects(options = {}) {
  const { preserveSelection = true } = options;
  const payload = await apiRequest("/api/agile/projects");
  state.projects = Array.isArray(payload.projects) ? payload.projects : [];

  if (preserveSelection && state.selectedProjectId) {
    const stillExists = state.projects.some((item) => item.projectId === state.selectedProjectId);
    if (!stillExists) {
      state.selectedProjectId = null;
      state.selectedItemId = null;
      state.projectDraft = null;
      state.itemDraft = null;
    }
  }

  if (!state.selectedProjectId && state.projects.length) {
    state.selectedProjectId = state.projects[0].projectId;
  }
}

async function loadProjectDetail(projectId, options = {}) {
  if (!projectId) {
    return;
  }

  const { force = false } = options;
  if (!force && state.projectDetails[projectId]) {
    ensureDrafts(projectId, { force: false });
    return;
  }

  const payload = await apiRequest(`/api/agile/projects/${encodeURIComponent(projectId)}`);
  state.projectDetails[projectId] = payload;
  ensureDrafts(projectId, { force: true });
}

async function loadServiceKeys() {
  const payload = await apiRequest("/api/service-keys");
  state.serviceKeys = Array.isArray(payload.serviceKeys) ? payload.serviceKeys : [];
}

function renderAll() {
  if (!state.session) {
    document.body.dataset.overlayOpen = "false";
    return;
  }

  elements.portalShell.dataset.view = state.activeView;
  elements.portalShell.dataset.viewport = state.viewport;
  elements.portalShell.dataset.navOpen = String(state.navDrawerOpen);
  elements.portalShell.dataset.detailOpen = String(shouldShowDetailOverlay());
  elements.portalShell.dataset.overlayOpen = String(isOverlayOpen());
  document.body.dataset.overlayOpen = String(isOverlayOpen());

  renderShell();
  renderProjectRail();
  renderViewSwitcher();
  renderSummaryStrip();
  renderWorkspaceView();
  renderDetailPane();
}

function renderShell() {
  document.title = state.session.app.title;
  elements.brandTitle.textContent = state.session.app.title;
  elements.brandSubtitle.textContent = state.session.app.subtitle;
  elements.sessionRole.textContent = state.session.user.roleLabel;
  elements.sessionName.textContent = state.session.user.displayName;
  elements.sessionEmail.textContent = state.session.user.email;

  const projectSummary = selectedProjectSummary();
  const projectDraft = activeProjectDraft();
  elements.pageTitle.textContent = projectDraft?.name || projectSummary?.name || state.session.app.title;
  elements.pageSubtitle.textContent = buildPageSubtitle(projectSummary, projectDraft);

  const canManage = Boolean(state.session.permissions?.agileManage);
  const canCreateItems = canManage && Boolean(state.selectedProjectId) && state.activeView !== "settings";

  elements.projectCreateButton.disabled = !canManage;
  elements.itemCreateEpic.disabled = !canCreateItems;
  elements.itemCreateStory.disabled = !canCreateItems;
  elements.itemCreateTask.disabled = !canCreateItems;
  elements.itemCreateActions.hidden = state.activeView === "settings";
  elements.itemCreateActions.setAttribute("aria-hidden", state.activeView === "settings" ? "true" : "false");
  elements.navToggleButton.hidden = state.viewport === "desktop";
  elements.navCloseButton.hidden = state.viewport === "desktop";
  elements.navToggleButton.setAttribute("aria-expanded", String(state.navDrawerOpen));
  elements.shellBackdrop.hidden = !isOverlayOpen();
}

function renderProjectRail() {
  elements.projectList.innerHTML = renderProjectList();
}

function renderViewSwitcher() {
  const buttons = elements.viewSwitcher.querySelectorAll("[data-view-switch]");
  for (const button of buttons) {
    const isActive = button.dataset.viewSwitch === state.activeView;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }
}

function renderSummaryStrip() {
  const summary = selectedProjectSummary();
  if (summary) {
    elements.projectSummaryStrip.innerHTML = renderProjectStats(summary);
    return;
  }

  elements.projectSummaryStrip.innerHTML = renderWorkspaceStats();
}

function renderWorkspaceView() {
  if (state.activeView === "settings") {
    elements.workspaceView.innerHTML = renderSettingsView();
    return;
  }

  if (!activeProjectDraft()) {
    elements.workspaceView.innerHTML = renderEmptySurface(
      "Select a project from the rail or create a new one to begin planning work.",
    );
    return;
  }

  if (state.activeView === "board") {
    elements.workspaceView.innerHTML = renderBoardView();
    return;
  }

  elements.workspaceView.innerHTML = renderListView();
}

function renderDetailPane() {
  if (state.activeView === "settings") {
    setVisibility(elements.detailPane, false, "block");
    elements.detailPane.innerHTML = "";
    return;
  }

  const shouldRenderPane = state.viewport === "desktop" || shouldShowDetailOverlay();
  setVisibility(elements.detailPane, shouldRenderPane, "block");
  if (!shouldRenderPane) {
    elements.detailPane.innerHTML = "";
    return;
  }

  if (!activeProjectDraft()) {
    elements.detailPane.innerHTML = `
      <div class="detail-pane-shell">
        <div class="empty-state">Choose a project to open the detail pane.</div>
      </div>
    `;
    return;
  }

  const itemDraft = activeItemDraft();
  if (!itemDraft) {
    elements.detailPane.innerHTML = `
      <div class="detail-pane-shell">
        <div class="empty-state">Select a work item from the list or board to edit it here.</div>
      </div>
    `;
    return;
  }

  elements.detailPane.innerHTML = renderItemDetailPane();
}

function renderProjectList() {
  if (!state.projects.length) {
    return `
      <div class="empty-state">
        No agile projects are stored yet. Create one to start organizing work.
      </div>
    `;
  }

  const projectItems = state.projects
    .map((project) => {
      const isActive = project.projectId === state.selectedProjectId && !isCreatingProject();
      const implementing = project.countsByStatus?.implementing || 0;
      const countsText = `${project.itemCount || 0} items`;
      const progressText = implementing ? `${implementing} in progress` : `${project.countsByStatus?.backlog || 0} in backlog`;
      return `
        <button
          class="project-nav-item ${isActive ? "is-active" : ""}"
          type="button"
          data-project-select="${escapeHtml(project.projectId)}"
        >
          <div class="project-nav-item__row">
            <span class="project-nav-item__name">${escapeHtml(project.name)}</span>
            ${renderBadge(formatProjectStatus(project.status), project.status === "active" ? "accent" : "neutral")}
          </div>
          <div class="project-nav-item__meta">${escapeHtml(countsText)}</div>
          <div class="project-nav-item__subtle">${escapeHtml(progressText)}</div>
        </button>
      `;
    })
    .join("");

  if (isCreatingProject()) {
    return `${projectItems}<div class="empty-state">A new project draft is open in Settings.</div>`;
  }

  return projectItems;
}

function renderListView() {
  const detail = selectedProjectDetail();
  const items = Array.isArray(detail?.items) ? detail.items : [];
  const itemMaps = buildWorkItemMaps(items);

  return `
    <section class="surface">
      ${renderNotice(state.workspaceNotice)}
      <div class="surface-header">
        <div>
          <p class="section-label">List view</p>
          <h3 class="surface-title">Work items</h3>
        </div>
        <div class="inline-meta">${escapeHtml(`${items.length} items`)}</div>
      </div>
      <div class="surface-body">
        ${items.length ? renderWorkTable(items, itemMaps) : `
          <div class="empty-state">This project has no work items yet. Start with an epic or a story.</div>
        `}
      </div>
    </section>
  `;
}

function renderBoardView() {
  const detail = selectedProjectDetail();
  const items = Array.isArray(detail?.items) ? detail.items : [];
  const itemMaps = buildWorkItemMaps(items);

  return `
    <section class="surface">
      ${renderNotice(state.workspaceNotice)}
      <div class="surface-header">
        <div>
          <p class="section-label">Board view</p>
          <h3 class="surface-title">Delivery flow</h3>
        </div>
        <div class="inline-meta">${escapeHtml(`${items.length} items`)}</div>
      </div>
      <div class="surface-body">
        ${items.length ? `
          <div class="board-grid">
            ${WORK_ITEM_STATUSES.map((status) => renderBoardColumn(status, items.filter((item) => item.status === status), itemMaps)).join("")}
          </div>
        ` : `
          <div class="empty-state">This project has no work items yet. Start with an epic or a story.</div>
        `}
      </div>
    </section>
  `;
}

function renderSettingsView() {
  const canManage = Boolean(state.session?.permissions?.agileManage);
  return `
    ${renderNotice(state.workspaceNotice)}
    <div class="settings-layout">
      ${renderProjectSettingsSection(canManage)}
      ${canManage ? renderServiceAccessSection() : ""}
    </div>
  `;
}

function renderProjectSettingsSection(canManage) {
  const projectDraft = activeProjectDraft();
  if (!projectDraft) {
    return `
      <section class="settings-section">
        <div class="settings-section-header">
          <div>
            <p class="section-label">Project settings</p>
            <h3 class="surface-title">Configuration</h3>
          </div>
        </div>
        <div class="settings-section-body">
          <div class="empty-state">Select an existing project or create a new one to edit project settings.</div>
        </div>
      </section>
    `;
  }

  const isExisting = Boolean(state.selectedProjectId && projectDraft.project_id);

  return `
    <section class="settings-section">
      <div class="settings-section-header">
        <div>
          <p class="section-label">Project settings</p>
          <h3 class="surface-title">${escapeHtml(projectDraft.name || "Project configuration")}</h3>
        </div>
        <div class="settings-actions">
          <button class="button button-primary" type="button" data-action="save-project" ${!canManage ? "disabled" : ""}>Save project</button>
          <button class="button" type="button" data-action="delete-project" ${!canManage || !state.selectedProjectId ? "disabled" : ""}>Delete project</button>
        </div>
      </div>
      <div class="settings-section-body">
        <div class="settings-form">
          ${renderField("Project key", "project_id", projectDraft.project_id || "", {
            editor: "project",
            placeholder: "team-ops-platform",
            disabled: isExisting,
          })}
          ${renderField("Project name", "name", projectDraft.name || "", {
            editor: "project",
            className: "field--title",
            placeholder: "Operations planning workspace",
            required: true,
          })}
          ${renderField("Status", "status", projectDraft.status || "active", {
            editor: "project",
            type: "select",
            options: projectStatusOptions(),
          })}
          ${renderField("Description", "description", projectDraft.description || "", {
            editor: "project",
            type: "textarea",
            className: "field--large",
            rows: 7,
            placeholder: "Capture the purpose, scope, stakeholders, and delivery guardrails for this project.",
          })}
        </div>
      </div>
    </section>
  `;
}

function renderServiceAccessSection() {
  return `
    <section class="settings-section">
      <div class="settings-section-header">
        <div>
          <p class="section-label">Service access</p>
          <h3 class="surface-title">Codex API keys</h3>
        </div>
        <button class="button button-primary" type="button" data-action="create-service-key">Generate key</button>
      </div>
      <div class="settings-section-body">
        ${renderNotice(state.serviceKeyNotice)}
        <div class="service-key-callout">
          <div class="stack">
            <p class="meta-label">Trusted automation</p>
            <p class="meta-text">Use <span class="mono">X-API-Key</span> from another Codex project against <span class="mono">${escapeHtml(serviceBaseUrl())}/agile/projects</span>.</p>
          </div>
        </div>
        <div class="service-key-form">
          ${renderField("Key label", "label", state.serviceKeyDraft.label || "", {
            editor: "service-key",
            placeholder: "Personal Codex automation",
          })}
          ${renderField("Allowed project IDs", "allowed_project_ids", joinList(state.serviceKeyDraft.allowed_project_ids || []), {
            editor: "service-key",
            valueType: "csv",
            placeholder: "Leave blank for full workspace access, or enter ids like hockeymanageragent",
          })}
          ${state.createdServiceKey ? `
            <div class="service-key-callout">
              <div class="stack">
                <p class="meta-label">Copy now</p>
                <p class="meta-text">The full key is only shown once.</p>
                <div class="mono">${escapeHtml(state.createdServiceKey)}</div>
              </div>
            </div>
          ` : ""}
        </div>
        <div class="service-key-list">
          ${state.serviceKeys.length ? state.serviceKeys.map((serviceKey) => renderServiceKeyRow(serviceKey)).join("") : `
            <div class="empty-state">No service keys exist yet. Generate one when you want another Codex project to read and write records.</div>
          `}
        </div>
      </div>
    </section>
  `;
}

function renderItemDetailPane() {
  const detail = selectedProjectDetail();
  const items = Array.isArray(detail?.items) ? detail.items : [];
  const itemDraft = activeItemDraft();
  const canManage = Boolean(state.session?.permissions?.agileManage);
  const isExisting = Boolean(state.selectedItemId && itemDraft.item_id);
  const parentOptions = itemParentOptions(items, itemDraft);
  const itemMaps = buildWorkItemMaps(items);
  const parentLabel = itemDraft.parent_id ? itemMaps.itemsById.get(itemDraft.parent_id)?.title || itemDraft.parent_id : "No parent";
  const childCount = itemMaps.childCountByParent[itemDraft.item_id] || 0;

  return `
    <div class="detail-pane-shell">
      <div class="detail-pane-header">
        <div class="stack">
          <p class="section-label">Selected work item</p>
          <h3 class="detail-pane-title">${escapeHtml(itemDraft.title || itemDraft.item_id || `New ${formatItemType(itemDraft.item_type).toLowerCase()}`)}</h3>
          <p class="detail-pane-summary">
            ${escapeHtml(formatItemType(itemDraft.item_type))} &middot;
            ${escapeHtml(formatItemStatus(itemDraft.status))} &middot;
            ${escapeHtml(formatPriority(itemDraft.priority))}
          </p>
          <p class="detail-pane-summary">
            ${escapeHtml(parentLabel)}${childCount ? ` &middot; ${childCount} child${childCount === 1 ? "" : "ren"}` : ""}
          </p>
        </div>
        <div class="detail-pane-actions">
          <button class="button button-subtle detail-pane-close" type="button" data-action="close-item-editor">Close</button>
          <button class="button button-primary" type="button" data-action="save-item" ${!canManage ? "disabled" : ""}>Save item</button>
          <button class="button" type="button" data-action="delete-item" ${!canManage || !state.selectedItemId ? "disabled" : ""}>Delete item</button>
        </div>
      </div>
      <div class="detail-pane-body">
        <div class="detail-form">
          ${renderField("Item key", "item_id", itemDraft.item_id || "", {
            editor: "item",
            placeholder: "story-key",
            disabled: isExisting,
          })}
          ${renderField("Title", "title", itemDraft.title || "", {
            editor: "item",
            className: "field--title",
            placeholder: "As a user, I can ...",
            required: true,
          })}
          ${renderField("Type", "item_type", itemDraft.item_type || "story", {
            editor: "item",
            type: "select",
            options: itemTypeOptions(),
          })}
          ${renderField("State", "status", itemDraft.status || "new", {
            editor: "item",
            type: "select",
            options: itemStatusOptions(),
          })}
          ${renderField("Priority", "priority", itemDraft.priority || "medium", {
            editor: "item",
            type: "select",
            options: priorityOptions(),
          })}
          ${renderField("Parent", "parent_id", itemDraft.parent_id || "", {
            editor: "item",
            type: "select",
            options: parentOptions,
          })}
          ${renderField("Rank", "rank", valueOrEmpty(itemDraft.rank ?? 100), {
            editor: "item",
            type: "number",
          })}
          ${renderField("Assignees", "assignee_emails", joinList(itemDraft.assignee_emails || []), {
            editor: "item",
            valueType: "csv",
            placeholder: "user@example.com",
          })}
          ${renderField("Tags", "tags", joinList(itemDraft.tags || []), {
            editor: "item",
            valueType: "csv",
            placeholder: "ui, backend, aws",
          })}
          ${renderField("Summary", "summary", itemDraft.summary || "", {
            editor: "item",
            type: "textarea",
            className: "field--large",
            rows: 6,
            placeholder: "Short planning note or implementation summary.",
          })}
          ${renderField("User story", "user_story", itemDraft.user_story || "", {
            editor: "item",
            type: "textarea",
            className: "field--large",
            rows: 6,
            placeholder: "As a ..., I want ..., so that ...",
          })}
          ${renderField("Acceptance criteria", "acceptance_criteria", (itemDraft.acceptance_criteria || []).join("\n"), {
            editor: "item",
            type: "textarea",
            valueType: "lines",
            className: "field--xlarge",
            rows: 8,
            placeholder: "One acceptance criterion per line",
          })}
        </div>
      </div>
    </div>
  `;
}

function renderWorkTable(items, itemMaps) {
  return `
    <div class="work-table">
      <div class="work-row work-row--head">
        <div class="table-head work-cell--title">Title</div>
        <div class="table-head work-cell--type">Type</div>
        <div class="table-head work-cell--status">Status</div>
        <div class="table-head work-cell--priority">Priority</div>
        <div class="table-head work-cell--parent">Parent</div>
        <div class="table-head work-cell--assignee">Assignee</div>
        <div class="table-head work-cell--tags">Tags</div>
      </div>
      ${items.map((item) => renderWorkRow(item, itemMaps)).join("")}
    </div>
  `;
}

function renderWorkRow(item, itemMaps) {
  const summary = item.userStory || item.summary || "";
  const parent = item.parentId ? itemMaps.itemsById.get(item.parentId)?.title || item.parentId : "-";
  const assignee = item.assigneeEmails?.[0] || "-";
  const tags = item.tags?.length ? item.tags.join(", ") : "-";

  return `
    <button
      class="work-row ${item.itemId === state.selectedItemId ? "is-selected" : ""}"
      type="button"
      data-item-select="${escapeHtml(item.itemId)}"
    >
      <div class="work-cell work-cell--title" data-cell-label="Title">
        <div class="work-title">
          <strong>${escapeHtml(item.title)}</strong>
          <span>${escapeHtml(summary ? truncate(summary, 88) : item.itemId)}</span>
        </div>
      </div>
      <div class="work-cell work-cell--type" data-cell-label="Type">${escapeHtml(formatItemType(item.itemType))}</div>
      <div class="work-cell work-cell--status" data-cell-label="Status">${renderBadge(formatItemStatus(item.status), item.status === "implementing" ? "accent" : "neutral")}</div>
      <div class="work-cell work-cell--priority" data-cell-label="Priority">${escapeHtml(formatPriority(item.priority))}</div>
      <div class="work-cell work-cell--parent" data-cell-label="Parent">${escapeHtml(parent)}</div>
      <div class="work-cell work-cell--assignee" data-cell-label="Assignee">${escapeHtml(assignee)}</div>
      <div class="work-cell work-cell--tags" data-cell-label="Tags">${escapeHtml(tags)}</div>
    </button>
  `;
}

function renderBoardColumn(status, items, itemMaps) {
  return `
    <section class="board-column">
      <div class="board-column-header">
        <div>
          <p class="section-label">${escapeHtml(formatItemStatus(status))}</p>
          <h3>${escapeHtml(String(items.length))}</h3>
        </div>
        ${renderBadge(formatItemStatus(status), status === "implementing" ? "accent" : "neutral")}
      </div>
      <div class="board-column-body">
        ${items.length ? items.map((item) => renderBoardCard(item, itemMaps)).join("") : `<div class="empty-state">No items in ${escapeHtml(formatItemStatus(status))}.</div>`}
      </div>
    </section>
  `;
}

function renderBoardCard(item, itemMaps) {
  const parent = item.parentId ? itemMaps.itemsById.get(item.parentId)?.title || item.parentId : "";
  const childCount = itemMaps.childCountByParent[item.itemId] || 0;
  const secondaryBits = [
    formatItemType(item.itemType),
    formatPriority(item.priority),
    item.assigneeEmails?.[0] || "",
  ].filter(Boolean);
  const referenceBits = [
    parent ? `Parent: ${parent}` : "",
    childCount ? `${childCount} child${childCount === 1 ? "" : "ren"}` : "",
  ].filter(Boolean);

  return `
    <button
      class="board-card ${item.itemId === state.selectedItemId ? "is-selected" : ""}"
      type="button"
      data-item-select="${escapeHtml(item.itemId)}"
    >
      <strong class="board-card-title">${escapeHtml(item.title)}</strong>
      ${secondaryBits.length ? `<div class="board-card-meta">${escapeHtml(secondaryBits.join(" | "))}</div>` : ""}
      ${referenceBits.length ? `<div class="board-card-meta">${escapeHtml(referenceBits.join(" | "))}</div>` : ""}
    </button>
  `;
}

function renderServiceKeyRow(serviceKey) {
  const scopeText = Array.isArray(serviceKey.allowedProjectIds) && serviceKey.allowedProjectIds.length
    ? `Projects: ${serviceKey.allowedProjectIds.join(", ")}`
    : "Projects: full workspace";
  return `
    <div class="service-key-row">
      <div class="service-key-row__body">
        <strong>${escapeHtml(serviceKey.label || serviceKey.keyId)}</strong>
        <div class="service-key-row__meta">${escapeHtml(serviceKey.keyPreview || serviceKey.keyId)}</div>
        <div class="service-key-row__meta">
          ${escapeHtml(`Created ${formatTimestamp(serviceKey.createdAtUtc)}`)}
          ${serviceKey.lastUsedAtUtc ? ` | ${escapeHtml(`Last used ${formatTimestamp(serviceKey.lastUsedAtUtc)}`)}` : ""}
        </div>
        <div class="service-key-row__meta">${escapeHtml(scopeText)}</div>
      </div>
      <div class="service-key-row__meta">
        ${renderBadge(formatServiceKeyStatus(serviceKey.status), serviceKey.status === "active" ? "accent" : "neutral")}
        <button
          class="button"
          type="button"
          data-action="revoke-service-key"
          data-service-key-id="${escapeHtml(serviceKey.keyId)}"
          ${serviceKey.status !== "active" ? "disabled" : ""}
        >
          Revoke
        </button>
      </div>
    </div>
  `;
}

function renderProjectStats(project) {
  const countsByStatus = project?.countsByStatus || {};
  const stats = [
    { label: "Status", value: formatProjectStatus(project?.status || "active") },
    { label: "Items", value: String(project?.itemCount || 0) },
    { label: "New", value: String(countsByStatus.new || 0) },
    { label: "Backlog", value: String(countsByStatus.backlog || 0) },
    { label: "Implementing", value: String(countsByStatus.implementing || 0) },
    { label: "Done", value: String(countsByStatus.done || 0) },
  ];

  return stats.map((item) => `
    <div class="summary-stat">
      <span>${escapeHtml(item.label)}</span>
      <strong>${escapeHtml(item.value)}</strong>
    </div>
  `).join("");
}

function renderWorkspaceStats() {
  const aggregate = state.projects.reduce(
    (accumulator, project) => {
      accumulator.projects += 1;
      accumulator.new += project.countsByStatus?.new || 0;
      accumulator.backlog += project.countsByStatus?.backlog || 0;
      accumulator.implementing += project.countsByStatus?.implementing || 0;
      accumulator.done += project.countsByStatus?.done || 0;
      return accumulator;
    },
    { projects: 0, new: 0, backlog: 0, implementing: 0, done: 0 },
  );

  const stats = [
    { label: "Projects", value: String(aggregate.projects) },
    { label: "New", value: String(aggregate.new) },
    { label: "Backlog", value: String(aggregate.backlog) },
    { label: "Implementing", value: String(aggregate.implementing) },
    { label: "Done", value: String(aggregate.done) },
  ];

  return stats.map((item) => `
    <div class="summary-stat">
      <span>${escapeHtml(item.label)}</span>
      <strong>${escapeHtml(item.value)}</strong>
    </div>
  `).join("");
}

function renderNotice(notice) {
  if (!notice?.message) {
    return "";
  }
  return `<p class="notice ${notice.tone || ""}">${escapeHtml(notice.message)}</p>`;
}

function renderEmptySurface(message) {
  return `
    <section class="surface">
      ${renderNotice(state.workspaceNotice)}
      <div class="empty-state">${escapeHtml(message)}</div>
    </section>
  `;
}

function renderField(label, path, value, options = {}) {
  const {
    editor = "item",
    type = "text",
    valueType = type === "number" ? "int" : "string",
    placeholder = "",
    required = false,
    step = "1",
    disabled = false,
    options: selectOptions = [],
    className = "",
    rows = 6,
  } = options;

  const controlAttributes = [
    `data-editor="${escapeHtml(editor)}"`,
    `data-field-path="${escapeHtml(path)}"`,
    `data-value-type="${escapeHtml(valueType)}"`,
    placeholder ? `placeholder="${escapeHtml(placeholder)}"` : "",
    required ? "required" : "",
    disabled ? "disabled" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (type === "textarea") {
    return `
      <label class="field ${className}">
        <span>${escapeHtml(label)}</span>
        <textarea rows="${escapeHtml(String(rows))}" ${controlAttributes}>${escapeHtml(value ?? "")}</textarea>
      </label>
    `;
  }

  if (type === "select") {
    return `
      <label class="field ${className}">
        <span>${escapeHtml(label)}</span>
        <select ${controlAttributes}>
          ${selectOptions
            .map((option) => `
              <option value="${escapeHtml(option.value)}" ${String(option.value) === String(value ?? "") ? "selected" : ""}>
                ${escapeHtml(option.label)}
              </option>
            `)
            .join("")}
        </select>
      </label>
    `;
  }

  return `
    <label class="field ${className}">
      <span>${escapeHtml(label)}</span>
      <input
        type="${escapeHtml(type)}"
        value="${escapeHtml(value ?? "")}"
        ${type === "number" ? `step="${escapeHtml(step)}"` : ""}
        ${controlAttributes}
      >
    </label>
  `;
}

async function handleProjectListClick(event) {
  const button = event.target.closest("[data-project-select]");
  if (!button) {
    return;
  }

  const projectId = button.dataset.projectSelect;
  if (!projectId) {
    return;
  }

  state.selectedProjectId = projectId;
  state.selectedItemId = null;
  state.projectDraft = null;
  state.itemDraft = null;
  state.activeView = DEFAULT_VIEW;
  state.navDrawerOpen = false;
  state.detailPaneOpen = false;
  setWorkspaceNotice("Loading project...", "");
  renderAll();

  try {
    await loadProjectDetail(projectId, { force: false });
    setWorkspaceNotice("Project loaded.", "");
  } catch (error) {
    console.error(error);
    setWorkspaceNotice(error.message || "Could not load the project.", "is-error");
  }

  renderAll();
}

function handleViewSwitchClick(event) {
  const button = event.target.closest("[data-view-switch]");
  if (!button) {
    return;
  }

  const nextView = button.dataset.viewSwitch;
  if (!nextView || nextView === state.activeView) {
    return;
  }

  state.activeView = nextView;
  if (nextView === "settings") {
    state.detailPaneOpen = false;
  }
  renderAll();
}

async function handleWorkspaceViewClick(event) {
  const selectable = event.target.closest("[data-item-select]");
  if (selectable) {
    selectItem(selectable.dataset.itemSelect);
    return;
  }

  const actionButton = event.target.closest("[data-action]");
  if (!actionButton) {
    return;
  }

  switch (actionButton.dataset.action) {
    case "save-project":
      await saveProjectDraft();
      break;
    case "delete-project":
      await deleteSelectedProject();
      break;
    case "create-service-key":
      await createServiceKey();
      break;
    case "revoke-service-key":
      await revokeServiceKey(actionButton.dataset.serviceKeyId);
      break;
    default:
      break;
  }
}

function handleWorkspaceViewInput(event) {
  const control = event.target;
  const path = control.dataset.fieldPath;
  const editor = control.dataset.editor;

  if (!path || !editor) {
    return;
  }

  if (editor === "project" && state.projectDraft) {
    setNestedValue(state.projectDraft, path, readControlValue(control));
    return;
  }

  if (editor === "service-key" && state.serviceKeyDraft) {
    setNestedValue(state.serviceKeyDraft, path, readControlValue(control));
  }
}

async function handleDetailPaneClick(event) {
  const actionButton = event.target.closest("[data-action]");
  if (!actionButton) {
    return;
  }

  switch (actionButton.dataset.action) {
    case "close-item-editor":
      closeDetailPane();
      break;
    case "save-item":
      await saveItemDraft();
      break;
    case "delete-item":
      await deleteSelectedItem();
      break;
    default:
      break;
  }
}

function handleDetailPaneInput(event) {
  const control = event.target;
  const path = control.dataset.fieldPath;
  const editor = control.dataset.editor;

  if (!path || editor !== "item" || !state.itemDraft) {
    return;
  }

  setNestedValue(state.itemDraft, path, readControlValue(control));
  if (path === "item_type") {
    const options = itemParentOptions(selectedProjectDetail()?.items || [], state.itemDraft);
    if (!options.some((option) => option.value === state.itemDraft.parent_id)) {
      state.itemDraft.parent_id = "";
    }
    renderDetailPane();
  }
}

function beginCreateProject() {
  state.selectedProjectId = null;
  state.selectedItemId = null;
  state.projectDraft = buildBlankProjectDraft();
  state.itemDraft = null;
  state.activeView = "settings";
  state.navDrawerOpen = false;
  state.detailPaneOpen = false;
  setWorkspaceNotice("New project draft opened.", "");
  renderAll();
}

function beginCreateItem(itemType) {
  if (!state.selectedProjectId) {
    setWorkspaceNotice("Select a project first so the new item has a home.", "is-error");
    renderAll();
    return;
  }

  const parentId = suggestedParentId(itemType);
  state.itemDraft = buildBlankItemDraft(state.selectedProjectId, itemType, parentId);
  state.selectedItemId = null;
  if (state.activeView === "settings") {
    state.activeView = DEFAULT_VIEW;
  }
  openItemEditor();
  setWorkspaceNotice(`New ${formatItemType(itemType).toLowerCase()} draft opened.`, "");
  renderAll();
}

function selectItem(itemId) {
  if (!itemId || !state.selectedProjectId) {
    return;
  }

  const detail = selectedProjectDetail();
  const item = detail?.items?.find((candidate) => candidate.itemId === itemId);
  if (!item) {
    return;
  }

  state.selectedItemId = itemId;
  state.itemDraft = clone(normalizeItemConfig(item));
  openItemEditor();
  renderAll();
}

async function saveProjectDraft() {
  const draft = activeProjectDraft();
  if (!draft) {
    return;
  }

  const creating = isCreatingProject();
  const endpoint = creating
    ? "/api/agile/projects"
    : `/api/agile/projects/${encodeURIComponent(state.selectedProjectId)}`;
  const method = creating ? "POST" : "PUT";
  const payload = { project: normalizeProjectDraftForSave(draft) };

  setWorkspaceNotice(creating ? "Creating project..." : "Saving project...", "");
  renderAll();

  try {
    const response = await apiRequest(endpoint, {
      method,
      body: JSON.stringify(payload),
    });
    state.selectedProjectId = response.project.projectId;
    state.selectedItemId = response.items?.[0]?.itemId || null;
    state.projectDetails[response.project.projectId] = response;
    ensureDrafts(response.project.projectId, { force: true });
    await loadProjects({ preserveSelection: true });
    if (creating) {
      state.activeView = DEFAULT_VIEW;
    }
    setWorkspaceNotice(creating ? "Project created." : "Project changes saved.", "is-success");
  } catch (error) {
    console.error(error);
    setWorkspaceNotice(error.message || "Could not save the project.", "is-error");
  }

  renderAll();
}

async function saveItemDraft() {
  const draft = activeItemDraft();
  if (!draft || !state.selectedProjectId) {
    return;
  }

  const creating = !state.selectedItemId;
  const endpoint = creating
    ? `/api/agile/projects/${encodeURIComponent(state.selectedProjectId)}/items`
    : `/api/agile/projects/${encodeURIComponent(state.selectedProjectId)}/items/${encodeURIComponent(state.selectedItemId)}`;
  const method = creating ? "POST" : "PUT";
  const payload = { item: normalizeItemDraftForSave(draft) };

  setWorkspaceNotice(creating ? "Creating item..." : "Saving item...", "");
  renderAll();

  try {
    const response = await apiRequest(endpoint, {
      method,
      body: JSON.stringify(payload),
    });
    state.selectedProjectId = response.project.projectId;
    state.selectedItemId = response.item.itemId;
    state.projectDetails[response.project.projectId] = response;
    ensureDrafts(response.project.projectId, { force: true });
    await loadProjects({ preserveSelection: true });
    setWorkspaceNotice(creating ? "Work item created." : "Work item changes saved.", "is-success");
  } catch (error) {
    console.error(error);
    setWorkspaceNotice(error.message || "Could not save the work item.", "is-error");
  }

  renderAll();
}

async function deleteSelectedProject() {
  if (!state.selectedProjectId) {
    return;
  }

  const confirmed = window.confirm("Delete this project and all of its work items?");
  if (!confirmed) {
    return;
  }

  setWorkspaceNotice("Deleting project...", "");
  renderAll();

  try {
    await apiRequest(`/api/agile/projects/${encodeURIComponent(state.selectedProjectId)}`, {
      method: "DELETE",
      body: JSON.stringify({ cascade: true }),
    });
    delete state.projectDetails[state.selectedProjectId];
    state.selectedProjectId = null;
    state.selectedItemId = null;
    state.projectDraft = null;
    state.itemDraft = null;
    state.activeView = DEFAULT_VIEW;
    await loadProjects({ preserveSelection: false });
    if (state.selectedProjectId) {
      await loadProjectDetail(state.selectedProjectId, { force: true });
    }
    setWorkspaceNotice("Project deleted.", "is-success");
  } catch (error) {
    console.error(error);
    setWorkspaceNotice(error.message || "Could not delete the project.", "is-error");
  }

  renderAll();
}

async function deleteSelectedItem() {
  if (!state.selectedProjectId || !state.selectedItemId) {
    return;
  }

  const confirmed = window.confirm("Delete this item and any child items under it?");
  if (!confirmed) {
    return;
  }

  setWorkspaceNotice("Deleting item...", "");
  renderAll();

  try {
    const response = await apiRequest(
      `/api/agile/projects/${encodeURIComponent(state.selectedProjectId)}/items/${encodeURIComponent(state.selectedItemId)}`,
      {
        method: "DELETE",
        body: JSON.stringify({ cascade: true }),
      },
    );
    state.projectDetails[state.selectedProjectId] = response;
    state.selectedItemId = response.items?.[0]?.itemId || null;
    ensureDrafts(state.selectedProjectId, { force: true });
    await loadProjects({ preserveSelection: true });
    if (state.viewport !== "desktop" && !state.selectedItemId) {
      state.detailPaneOpen = false;
    }
    setWorkspaceNotice("Work item deleted.", "is-success");
  } catch (error) {
    console.error(error);
    setWorkspaceNotice(error.message || "Could not delete the work item.", "is-error");
  }

  renderAll();
}

async function createServiceKey() {
  setServiceKeyNotice("Generating service key...", "");
  renderAll();

  try {
    const response = await apiRequest("/api/service-keys", {
      method: "POST",
      body: JSON.stringify({
        serviceKey: {
          label: String(state.serviceKeyDraft.label || "").trim(),
          allowedProjectIds: normalizeStringArray(state.serviceKeyDraft.allowed_project_ids || []),
        },
      }),
    });
    state.createdServiceKey = response.plaintextKey || null;
    state.serviceKeyDraft = buildBlankServiceKeyDraft();
    await loadServiceKeys();
    setServiceKeyNotice("Service key created. Copy it now, then use it with X-API-Key.", "is-success");
  } catch (error) {
    console.error(error);
    setServiceKeyNotice(error.message || "Could not create the service key.", "is-error");
  }

  renderAll();
}

async function revokeServiceKey(keyId) {
  if (!keyId) {
    return;
  }

  const confirmed = window.confirm("Revoke this service key? Any Codex project using it will stop working immediately.");
  if (!confirmed) {
    return;
  }

  setServiceKeyNotice("Revoking service key...", "");
  renderAll();

  try {
    await apiRequest(`/api/service-keys/${encodeURIComponent(keyId)}`, {
      method: "DELETE",
    });
    await loadServiceKeys();
    setServiceKeyNotice("Service key revoked.", "is-success");
  } catch (error) {
    console.error(error);
    setServiceKeyNotice(error.message || "Could not revoke the service key.", "is-error");
  }

  renderAll();
}

function ensureDrafts(projectId, options = {}) {
  const { force = false } = options;
  const detail = state.projectDetails[projectId];
  if (!detail?.projectConfig) {
    return;
  }

  if (!state.projectDraft || force || state.projectDraft.project_id !== detail.projectConfig.projectId) {
    state.projectDraft = clone(normalizeProjectConfig(detail.projectConfig));
  }

  const items = Array.isArray(detail.items) ? detail.items : [];
  if (!items.length) {
    state.selectedItemId = null;
    state.itemDraft = null;
    state.detailPaneOpen = false;
    return;
  }

  const selected = items.find((item) => item.itemId === state.selectedItemId);
  if (!selected) {
    state.selectedItemId = items[0].itemId;
  }

  const nextSelected = items.find((item) => item.itemId === state.selectedItemId);
  if (!nextSelected) {
    state.itemDraft = null;
    return;
  }

  if (!state.itemDraft || force || state.itemDraft.item_id !== nextSelected.itemId) {
    state.itemDraft = clone(normalizeItemConfig(nextSelected));
  }
}

function selectedProjectSummary() {
  return state.projects.find((item) => item.projectId === state.selectedProjectId) || null;
}

function selectedProjectDetail() {
  return state.selectedProjectId ? state.projectDetails[state.selectedProjectId] || null : null;
}

function activeProjectDraft() {
  return state.projectDraft || null;
}

function activeItemDraft() {
  return state.itemDraft || null;
}

function isCreatingProject() {
  return Boolean(state.projectDraft && !state.selectedProjectId);
}

function buildBlankProjectDraft() {
  return {
    project_id: "",
    name: "",
    description: "",
    status: "active",
  };
}

function buildBlankItemDraft(projectId, itemType = "story", parentId = "") {
  const normalizedType = ["epic", "story", "task"].includes(itemType) ? itemType : "story";
  return {
    item_id: "",
    project_id: projectId || "",
    title: "",
    item_type: normalizedType,
    status: normalizedType === "task" ? "backlog" : "new",
    summary: "",
    user_story: normalizedType === "story" ? "As a ..., I want ..., so that ..." : "",
    acceptance_criteria: [],
    parent_id: parentId || "",
    priority: "medium",
    assignee_emails: [],
    tags: [],
    rank: 100,
  };
}

function buildBlankServiceKeyDraft() {
  return {
    label: "",
    allowed_project_ids: [],
  };
}

function normalizeProjectConfig(project) {
  return {
    project_id: project?.projectId || project?.project_id || "",
    name: project?.name || "",
    description: project?.description || "",
    status: project?.status || "active",
  };
}

function normalizeItemConfig(item) {
  return {
    item_id: item?.itemId || item?.item_id || "",
    project_id: item?.projectId || item?.project_id || state.selectedProjectId || "",
    title: item?.title || "",
    item_type: item?.itemType || item?.item_type || "story",
    status: item?.status || "new",
    summary: item?.summary || "",
    user_story: item?.userStory || item?.user_story || "",
    acceptance_criteria: Array.isArray(item?.acceptanceCriteria)
      ? item.acceptanceCriteria
      : Array.isArray(item?.acceptance_criteria)
        ? item.acceptance_criteria
        : [],
    parent_id: item?.parentId || item?.parent_id || "",
    priority: item?.priority || "medium",
    assignee_emails: Array.isArray(item?.assigneeEmails)
      ? item.assigneeEmails
      : Array.isArray(item?.assignee_emails)
        ? item.assignee_emails
        : [],
    tags: Array.isArray(item?.tags) ? item.tags : [],
    rank: item?.rank ?? 100,
  };
}

function normalizeProjectDraftForSave(project) {
  return {
    project_id: String(project.project_id || "").trim(),
    name: String(project.name || "").trim(),
    description: String(project.description || "").trim(),
    status: String(project.status || "active").trim() || "active",
  };
}

function normalizeItemDraftForSave(item) {
  return {
    item_id: String(item.item_id || "").trim(),
    title: String(item.title || "").trim(),
    item_type: String(item.item_type || "story").trim() || "story",
    status: String(item.status || "new").trim() || "new",
    summary: String(item.summary || "").trim(),
    user_story: String(item.user_story || "").trim(),
    acceptance_criteria: normalizeStringArray(item.acceptance_criteria || []),
    parent_id: String(item.parent_id || "").trim() || null,
    priority: String(item.priority || "medium").trim() || "medium",
    assignee_emails: normalizeStringArray(item.assignee_emails || []),
    tags: normalizeStringArray(item.tags || []),
    rank: parseNullableInteger(item.rank) ?? 100,
  };
}

function projectStatusOptions() {
  return [
    { value: "active", label: "Active" },
    { value: "archived", label: "Archived" },
  ];
}

function itemTypeOptions() {
  return [
    { value: "epic", label: "Epic" },
    { value: "story", label: "Story" },
    { value: "task", label: "Task" },
  ];
}

function itemStatusOptions() {
  return [
    { value: "new", label: "New" },
    { value: "backlog", label: "Backlog" },
    { value: "implementing", label: "Implementing" },
    { value: "done", label: "Done" },
  ];
}

function priorityOptions() {
  return [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "critical", label: "Critical" },
  ];
}

function itemParentOptions(items, draft) {
  const options = [{ value: "", label: "No parent" }];
  for (const candidate of items || []) {
    const normalized = normalizeItemConfig(candidate);
    if (normalized.item_id === draft.item_id) {
      continue;
    }
    if (!canParentItem(normalized.item_type, draft.item_type)) {
      continue;
    }
    options.push({
      value: normalized.item_id,
      label: `${formatItemType(normalized.item_type)}: ${normalized.title}`,
    });
  }
  return options;
}

function canParentItem(parentType, childType) {
  const allowed = {
    epic: new Set(["story", "task"]),
    story: new Set(["task"]),
    task: new Set(),
  };
  return allowed[parentType]?.has(childType) || false;
}

function suggestedParentId(itemType) {
  if (!state.selectedItemId) {
    return "";
  }

  const current = activeItemDraft() || normalizeItemConfig(
    selectedProjectDetail()?.items?.find((item) => item.itemId === state.selectedItemId),
  );
  if (!current?.item_type) {
    return "";
  }

  return canParentItem(current.item_type, itemType) ? current.item_id : "";
}

function buildWorkItemMaps(items) {
  const itemsById = new Map();
  const childCountByParent = {};

  for (const item of items || []) {
    itemsById.set(item.itemId, item);
    if (item.parentId) {
      childCountByParent[item.parentId] = (childCountByParent[item.parentId] || 0) + 1;
    }
  }

  return { itemsById, childCountByParent };
}

function buildPageSubtitle(projectSummary, projectDraft) {
  if (projectSummary) {
    const implementing = projectSummary.countsByStatus?.implementing || 0;
    const count = projectSummary.itemCount || 0;
    return projectSummary.description || `${count} work items | ${implementing} in progress.`;
  }

  if (projectDraft) {
    return projectDraft.description || "Configure the project, then move back into list or board execution views.";
  }

  return state.session?.app?.subtitle || "Hosted agile planning for projects, stories, and acceptance criteria.";
}

function renderBadge(label, tone = "neutral") {
  const resolvedTone = ["accent", "success", "warning"].includes(tone) ? tone : "neutral";
  return `<span class="badge ${resolvedTone !== "neutral" ? `badge--${resolvedTone}` : ""}">${escapeHtml(label)}</span>`;
}

function truncate(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function formatProjectStatus(value) {
  return value === "archived" ? "Archived" : "Active";
}

function formatItemType(value) {
  return String(value || "story").replace(/^\w/, (character) => character.toUpperCase());
}

function formatItemStatus(value) {
  switch (value) {
    case "backlog":
      return "Backlog";
    case "implementing":
      return "Implementing";
    case "done":
      return "Done";
    default:
      return "New";
  }
}

function formatPriority(value) {
  return String(value || "medium").replace(/^\w/, (character) => character.toUpperCase());
}

function formatServiceKeyStatus(value) {
  return value === "revoked" ? "Revoked" : "Active";
}

function formatTimestamp(value) {
  if (!value) {
    return "unknown time";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }
  return parsed.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function serviceBaseUrl() {
  return new URL("/service", window.location.origin).toString().replace(/\/$/, "");
}

function readControlValue(control) {
  const valueType = control.dataset.valueType || "string";
  if (valueType === "bool") {
    return Boolean(control.checked);
  }
  if (valueType === "csv") {
    return normalizeStringArray(String(control.value || "").split(","));
  }
  if (valueType === "lines") {
    return normalizeStringArray(String(control.value || "").split(/\r?\n/));
  }
  if (valueType === "int") {
    return parseNullableInteger(control.value);
  }
  if (valueType === "float") {
    return parseNullableFloat(control.value);
  }
  return control.value;
}

function setNestedValue(target, path, value) {
  const parts = path.split(".");
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    if (cursor[key] == null || typeof cursor[key] !== "object") {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
}

function normalizeStringArray(values) {
  return (values || [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function parseNullableInteger(value) {
  if (value === "" || value == null) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNullableFloat(value) {
  if (value === "" || value == null) {
    return null;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function valueOrEmpty(value) {
  return value == null ? "" : value;
}

function joinList(values) {
  return (values || []).join(", ");
}

function setWorkspaceNotice(message, tone) {
  state.workspaceNotice = {
    message: message || "",
    tone: tone || "",
  };
}

function setServiceKeyNotice(message, tone) {
  state.serviceKeyNotice = {
    message: message || "",
    tone: tone || "",
  };
}

function setBanner(message) {
  elements.statusBanner.textContent = message || "";
}

function showAuthGate(message) {
  state.navDrawerOpen = false;
  state.detailPaneOpen = false;
  document.body.dataset.overlayOpen = "false";
  setVisibility(elements.authGate, true, "grid");
  setVisibility(elements.portalShell, false, "grid");
  elements.authStatus.textContent = message;
}

function showPortal() {
  document.body.dataset.overlayOpen = "false";
  setVisibility(elements.authGate, false, "grid");
  setVisibility(elements.portalShell, true, "");
}

function handleViewportResize() {
  const nextViewport = getViewportCategory();
  if (nextViewport === state.viewport) {
    return;
  }

  const previousViewport = state.viewport;
  state.viewport = nextViewport;
  state.navDrawerOpen = false;

  if (nextViewport === "desktop") {
    state.detailPaneOpen = false;
  } else if (previousViewport === "desktop") {
    state.detailPaneOpen = Boolean(state.itemDraft);
  }

  renderAll();
}

function toggleNavigationDrawer() {
  if (state.viewport === "desktop") {
    return;
  }

  state.navDrawerOpen = !state.navDrawerOpen;
  if (state.navDrawerOpen) {
    state.detailPaneOpen = false;
  }
  renderAll();
}

function closeNavigationDrawer() {
  if (!state.navDrawerOpen) {
    return;
  }

  state.navDrawerOpen = false;
  renderAll();
}

function closeDetailPane() {
  if (state.viewport === "desktop" || !state.detailPaneOpen) {
    return;
  }

  state.detailPaneOpen = false;
  renderAll();
}

function closeOverlays() {
  if (!isOverlayOpen()) {
    return;
  }

  state.navDrawerOpen = false;
  state.detailPaneOpen = false;
  renderAll();
}

function openItemEditor() {
  state.navDrawerOpen = false;
  if (state.viewport !== "desktop") {
    state.detailPaneOpen = true;
  }
}

function shouldShowDetailOverlay() {
  return state.viewport !== "desktop" && state.activeView !== "settings" && state.detailPaneOpen;
}

function isOverlayOpen() {
  return state.navDrawerOpen || shouldShowDetailOverlay();
}

function getViewportCategory() {
  if (window.innerWidth >= 1200) {
    return "desktop";
  }
  if (window.innerWidth >= 768) {
    return "tablet";
  }
  return "mobile";
}

function setVisibility(element, visible, displayValue) {
  if (!element) {
    return;
  }
  element.hidden = !visible;
  element.style.display = visible ? displayValue : "none";
}

async function apiRequest(path, init = {}) {
  const headers = new Headers(init.headers || {});
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const apiToken = await auth.getApiToken();
  if (apiToken) {
    headers.set("Authorization", `Bearer ${apiToken}`);
  }

  const response = await fetch(`${config.apiBaseUrl}${path.replace(config.apiBaseUrl, "")}`, {
    ...init,
    headers,
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch (_error) {
    payload = { ok: false, error: "The workspace returned an unreadable response." };
  }

  if (!response.ok || payload.ok === false) {
    if ((response.status === 401 || response.status === 403) && config.authMode === "cognito") {
      await auth.clear();
    }
    throw new Error(payload.error || `Request failed (${response.status}).`);
  }

  return payload;
}

function normalizeConfig(raw) {
  const cognito = raw.cognito || {};
  return {
    authMode: raw.authMode || "none",
    apiBaseUrl: raw.apiBaseUrl || "/api",
    appTitle: raw.appTitle || "XLEO Agile Workspace",
    cognito: {
      clientId: cognito.clientId || "",
      domain: cognito.domain || "",
      scopes: Array.isArray(cognito.scopes) && cognito.scopes.length ? cognito.scopes : ["openid", "email", "profile"],
      redirectPath: cognito.redirectPath || "/auth/callback",
      logoutPath: cognito.logoutPath || "/",
    },
  };
}

function createAuthClient(appConfig) {
  if (appConfig.authMode !== "cognito") {
    return {
      async initialize() {
        return { authenticated: true };
      },
      async beginSignIn() {
        throw new Error("Hosted sign-in is only available in Cognito mode.");
      },
      async getApiToken() {
        return null;
      },
      async signOut() {},
      async clear() {},
    };
  }

  const storageKey = `xleo-agile-auth-${appConfig.cognito.clientId}`;
  const verifierKey = `${storageKey}-verifier`;
  const stateKey = `${storageKey}-state`;

  return {
    async initialize() {
      if (isCallbackRoute(appConfig)) {
        await completeHostedSignIn();
      } else {
        await refreshTokensIfNeeded();
      }
      return { authenticated: Boolean(loadTokens()) };
    },
    async beginSignIn() {
      const verifier = generateCodeVerifier();
      const challenge = await sha256Url(verifier);
      const stateValue = randomToken();
      sessionStorage.setItem(verifierKey, verifier);
      sessionStorage.setItem(stateKey, stateValue);

      const authorizeUrl = new URL(`https://${appConfig.cognito.domain}/oauth2/authorize`);
      authorizeUrl.searchParams.set("client_id", appConfig.cognito.clientId);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("scope", appConfig.cognito.scopes.join(" "));
      authorizeUrl.searchParams.set("redirect_uri", redirectUri(appConfig));
      authorizeUrl.searchParams.set("state", stateValue);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      authorizeUrl.searchParams.set("code_challenge", challenge);

      window.location.assign(authorizeUrl.toString());
    },
    async getApiToken() {
      await refreshTokensIfNeeded();
      const tokens = loadTokens();
      return tokens?.id_token || tokens?.access_token || null;
    },
    async signOut() {
      const tokens = loadTokens();
      await clearTokens();

      const logoutUrl = new URL(`https://${appConfig.cognito.domain}/logout`);
      logoutUrl.searchParams.set("client_id", appConfig.cognito.clientId);
      logoutUrl.searchParams.set("logout_uri", logoutUri(appConfig));
      if (tokens?.id_token) {
        logoutUrl.searchParams.set("logout_hint", decodeJwt(tokens.id_token)?.email || "");
      }
      window.location.assign(logoutUrl.toString());
    },
    async clear() {
      await clearTokens();
    },
  };

  async function completeHostedSignIn() {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");
    const expectedState = sessionStorage.getItem(stateKey);
    const verifier = sessionStorage.getItem(verifierKey);

    if (!code || !returnedState || !expectedState || returnedState !== expectedState || !verifier) {
      throw new Error("Hosted sign-in could not be completed.");
    }

    const tokenResponse = await fetch(`https://${appConfig.cognito.domain}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: appConfig.cognito.clientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri(appConfig),
      }),
    });

    const payload = await tokenResponse.json();
    if (!tokenResponse.ok || !payload.access_token) {
      throw new Error(payload.error_description || "Token exchange failed.");
    }

    persistTokens(payload);
    sessionStorage.removeItem(verifierKey);
    sessionStorage.removeItem(stateKey);
    window.history.replaceState({}, document.title, logoutUri(appConfig));
  }

  async function refreshTokensIfNeeded() {
    const tokens = loadTokens();
    if (!tokens) {
      return;
    }

    const sessionTokenPayload = decodeJwt(tokens.id_token || tokens.access_token);
    if (sessionTokenPayload?.exp && sessionTokenPayload.exp * 1000 > Date.now() + 60_000) {
      return;
    }

    if (!tokens.refresh_token) {
      await clearTokens();
      return;
    }

    const refreshResponse = await fetch(`https://${appConfig.cognito.domain}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: appConfig.cognito.clientId,
        refresh_token: tokens.refresh_token,
      }),
    });

    const payload = await refreshResponse.json();
    if (!refreshResponse.ok || !payload.access_token) {
      await clearTokens();
      return;
    }

    persistTokens({
      ...payload,
      refresh_token: tokens.refresh_token,
    });
  }

  function loadTokens() {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? JSON.parse(raw) : null;
    } catch (_error) {
      return null;
    }
  }

  function persistTokens(payload) {
    localStorage.setItem(storageKey, JSON.stringify(payload));
  }

  async function clearTokens() {
    localStorage.removeItem(storageKey);
    sessionStorage.removeItem(verifierKey);
    sessionStorage.removeItem(stateKey);
  }
}

function isCallbackRoute(appConfig) {
  return window.location.pathname === appConfig.cognito.redirectPath && new URLSearchParams(window.location.search).has("code");
}

function redirectUri(appConfig) {
  return new URL(appConfig.cognito.redirectPath, window.location.origin).toString();
}

function logoutUri(appConfig) {
  return new URL(appConfig.cognito.logoutPath, window.location.origin).toString();
}

function generateCodeVerifier() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256Url(value) {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes) {
  let text = "";
  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function randomToken() {
  return base64Url(crypto.getRandomValues(new Uint8Array(16)));
}

function decodeJwt(token) {
  if (!token) {
    return null;
  }
  try {
    const [, payload] = token.split(".");
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    return JSON.parse(atob(padded));
  } catch (_error) {
    return null;
  }
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timeoutHandle = window.setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        window.clearTimeout(timeoutHandle);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeoutHandle);
        reject(error);
      },
    );
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
