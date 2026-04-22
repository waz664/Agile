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
  kpiStrip: document.querySelector("#kpi-strip"),
  projectCreateButton: document.querySelector("#project-create-button"),
  projectList: document.querySelector("#project-list"),
  projectTitle: document.querySelector("#project-title"),
  projectFeedback: document.querySelector("#project-feedback"),
  projectSummary: document.querySelector("#project-summary"),
  projectBoard: document.querySelector("#project-board"),
  projectEditor: document.querySelector("#project-editor"),
  projectSaveButton: document.querySelector("#project-save-button"),
  projectDeleteButton: document.querySelector("#project-delete-button"),
  itemCreateEpic: document.querySelector("#item-create-epic"),
  itemCreateStory: document.querySelector("#item-create-story"),
  itemCreateTask: document.querySelector("#item-create-task"),
  itemEditorTitle: document.querySelector("#item-editor-title"),
  itemEditor: document.querySelector("#item-editor"),
  itemSaveButton: document.querySelector("#item-save-button"),
  itemDeleteButton: document.querySelector("#item-delete-button"),
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

elements.projectSaveButton.addEventListener("click", async () => {
  await saveProjectDraft();
});

elements.projectDeleteButton.addEventListener("click", async () => {
  await deleteSelectedProject();
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

elements.itemSaveButton.addEventListener("click", async () => {
  await saveItemDraft();
});

elements.itemDeleteButton.addEventListener("click", async () => {
  await deleteSelectedItem();
});

elements.projectEditor.addEventListener("input", handleProjectEditorInput);
elements.projectEditor.addEventListener("change", handleProjectEditorInput);
elements.itemEditor.addEventListener("input", handleItemEditorInput);
elements.itemEditor.addEventListener("change", handleItemEditorInput);
elements.projectList.addEventListener("click", handleProjectListClick);
elements.projectBoard.addEventListener("click", handleBoardClick);

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

    showPortal();
    renderShell();
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

function renderShell() {
  document.title = state.session.app.title;
  elements.brandTitle.textContent = state.session.app.title;
  elements.brandSubtitle.textContent = state.session.app.subtitle;
  elements.pageTitle.textContent = state.session.app.title;
  elements.sessionRole.textContent = state.session.user.roleLabel;
  elements.sessionName.textContent = state.session.user.displayName;
  elements.sessionEmail.textContent = state.session.user.email;
}

function renderAll() {
  renderKpis();
  renderWorkspace();
}

function renderKpis() {
  const totalProjects = state.projects.length;
  const counts = state.projects.reduce(
    (accumulator, project) => {
      accumulator.new += project.countsByStatus?.new || 0;
      accumulator.backlog += project.countsByStatus?.backlog || 0;
      accumulator.implementing += project.countsByStatus?.implementing || 0;
      accumulator.done += project.countsByStatus?.done || 0;
      return accumulator;
    },
    { new: 0, backlog: 0, implementing: 0, done: 0 },
  );

  const cards = [
    {
      label: "Projects",
      value: String(totalProjects),
      note: totalProjects ? "Active workspaces available in the repo." : "Create your first project to start planning.",
    },
    {
      label: "Refinement",
      value: String(counts.new),
      note: "Items still being shaped and clarified.",
    },
    {
      label: "Backlog",
      value: String(counts.backlog),
      note: "Ready-to-build stories and tasks.",
    },
    {
      label: "Implementing",
      value: String(counts.implementing),
      note: "Active work currently in flight.",
    },
    {
      label: "Done",
      value: String(counts.done),
      note: "Completed and accepted work.",
    },
  ];

  elements.kpiStrip.innerHTML = cards
    .map(
      (card) => `
        <article class="kpi-card">
          <p class="table-meta">${escapeHtml(card.label)}</p>
          <strong>${escapeHtml(card.value)}</strong>
          <p class="small-note">${escapeHtml(card.note)}</p>
        </article>
      `,
    )
    .join("");
}

function renderWorkspace() {
  const canManage = Boolean(state.session?.permissions?.agileManage);
  const detail = selectedProjectDetail();
  const projectDraft = activeProjectDraft();
  const itemDraft = activeItemDraft();
  const projectSummary = selectedProjectSummary();

  elements.projectList.innerHTML = renderProjectList();
  elements.projectTitle.textContent = projectDraft?.name || projectSummary?.name || "Select a project";

  if (!projectDraft) {
    elements.projectSummary.innerHTML = `<div class="empty-state">Create a project to organize epics, stories, tasks, and acceptance criteria.</div>`;
    elements.projectBoard.innerHTML = `<div class="empty-state">Select or create a project to open the agile board.</div>`;
    elements.projectEditor.innerHTML = `<div class="empty-state">Choose a project from the list or create a new one.</div>`;
    elements.itemEditorTitle.textContent = "Select an item";
    elements.itemEditor.innerHTML = `<div class="empty-state">Once a project is selected, add epics, stories, or tasks here.</div>`;
  } else {
    elements.projectSummary.innerHTML = renderProjectSummary(projectSummary || detail?.project || projectDraft);
    elements.projectBoard.innerHTML = detail?.board
      ? renderProjectBoard(detail.board)
      : `<div class="empty-state">This project has no work items yet. Start with an epic or a story.</div>`;
    elements.projectEditor.innerHTML = renderProjectEditorForm(projectDraft);
    elements.itemEditorTitle.textContent = itemDraft?.title || itemDraft?.item_id || "Select an item";
    elements.itemEditor.innerHTML = renderItemEditorForm({
      itemDraft,
      items: detail?.items || [],
      projectDraft,
    });
  }

  elements.projectCreateButton.disabled = !canManage;
  elements.projectSaveButton.disabled = !canManage || !projectDraft;
  elements.projectDeleteButton.disabled = !canManage || !(projectDraft && state.selectedProjectId);
  elements.itemCreateEpic.disabled = !canManage || !projectDraft || !state.selectedProjectId;
  elements.itemCreateStory.disabled = !canManage || !projectDraft || !state.selectedProjectId;
  elements.itemCreateTask.disabled = !canManage || !projectDraft || !state.selectedProjectId;
  elements.itemSaveButton.disabled = !canManage || !itemDraft;
  elements.itemDeleteButton.disabled = !canManage || !(itemDraft && state.selectedItemId);

  if (!elements.projectFeedback.textContent.trim()) {
    setEditorFeedback(
      elements.projectFeedback,
      projectDraft
        ? "Keep projects lean: epics for outcomes, stories for user value, and tasks for execution detail."
        : "Create a project to start capturing stories and acceptance criteria.",
      "",
    );
  }
}

function renderProjectList() {
  if (!state.projects.length) {
    return `<div class="empty-state">No agile projects are stored yet. Create one to begin organizing work.</div>`;
  }

  return (
    state.projects
      .map((project) => `
        <button class="list-item ${project.projectId === state.selectedProjectId && !isCreatingProject() ? "is-active" : ""}" type="button" data-project-select="${escapeHtml(project.projectId)}">
          <strong>${escapeHtml(project.name)}</strong>
          <div class="list-item-meta">
            ${renderPill(formatProjectStatus(project.status), { status: project.status })}
            ${renderPill(`${project.itemCount || 0} item${project.itemCount === 1 ? "" : "s"}`, { kind: "neutral" })}
          </div>
          <div class="list-item-subtle">
            <span>${escapeHtml(`${project.countsByType?.epic || 0} epics`)}</span>
            <span>${escapeHtml(`${project.countsByType?.story || 0} stories`)}</span>
            <span>${escapeHtml(`${project.countsByType?.task || 0} tasks`)}</span>
            <span>${escapeHtml(`${project.countsByStatus?.implementing || 0} implementing`)}</span>
          </div>
        </button>
      `)
      .join("")
      + (isCreatingProject() ? `<div class="empty-state">A new project draft is open in the editor. Save it to add it to the live list.</div>` : "")
  );
}

function renderProjectSummary(project) {
  const countsByStatus = project?.countsByStatus || {};
  const countsByType = project?.countsByType || {};
  const items = [
    {
      label: "Status",
      value: formatProjectStatus(project?.status || "active"),
      note: project?.description || "Use the description to capture purpose, scope, or stakeholder context.",
    },
    {
      label: "Work items",
      value: String(project?.itemCount || 0),
      note: `${countsByType.epic || 0} epics, ${countsByType.story || 0} stories, ${countsByType.task || 0} tasks`,
    },
    {
      label: "Refinement",
      value: String(countsByStatus.new || 0),
      note: "Items still being shaped or clarified.",
    },
    {
      label: "Backlog",
      value: String(countsByStatus.backlog || 0),
      note: "Work ready to build.",
    },
    {
      label: "Implementing",
      value: String(countsByStatus.implementing || 0),
      note: "Active work currently in flight.",
    },
    {
      label: "Done",
      value: String(countsByStatus.done || 0),
      note: "Completed and accepted work.",
    },
  ];

  return items
    .map(
      (item) => `
        <article class="metric-panel">
          <p class="table-meta">${escapeHtml(item.label)}</p>
          <strong>${escapeHtml(item.value)}</strong>
          <p class="small-note">${escapeHtml(item.note)}</p>
        </article>
      `,
    )
    .join("");
}

function renderProjectBoard(board) {
  if (!board?.columns?.length) {
    return `<div class="empty-state">No board data is available yet for this project.</div>`;
  }

  return board.columns
    .map((column) => `
      <section class="agile-column">
        <div class="agile-column-header">
          <div>
            <p class="section-label">${escapeHtml(column.label)}</p>
            <h4>${escapeHtml(String(column.count || 0))}</h4>
          </div>
          ${renderPill(String(column.count || 0), { status: column.status })}
        </div>
        <div class="agile-column-cards">
          ${column.items?.length
            ? column.items.map((item) => renderProjectCard(item)).join("")
            : `<div class="empty-state">No items in ${escapeHtml(column.label)}.</div>`}
        </div>
      </section>
    `)
    .join("");
}

function renderProjectCard(item, depth = 0) {
  const selected = item.itemId === state.selectedItemId;
  const summary = item.userStory || item.summary || "";
  const criteriaCount = Array.isArray(item.acceptanceCriteria) ? item.acceptanceCriteria.length : 0;
  return `
    <div class="agile-card-shell" style="${depth > 0 ? `margin-left:${depth * 16}px;` : ""}">
      <button
        class="agile-card ${selected ? "is-selected" : ""}"
        type="button"
        data-item-select="${escapeHtml(item.itemId)}"
      >
        <div class="agile-card-header">
          <strong class="agile-card-title">${escapeHtml(item.title)}</strong>
          ${renderPill(formatItemType(item.itemType), { type: item.itemType })}
        </div>
        <div class="agile-card-meta">
          ${renderPill(formatItemStatus(item.status), { status: item.status })}
          ${renderPill(formatPriority(item.priority), { priority: item.priority })}
          ${renderPill(`${criteriaCount} criteria`, { kind: criteriaCount ? "success" : "warning" })}
        </div>
        ${summary ? `<p class="agile-card-story">${escapeHtml(summary)}</p>` : ""}
      </button>
      ${renderProjectCardChildren(item.children || [], depth + 1)}
    </div>
  `;
}

function renderProjectCardChildren(children, depth) {
  if (!children.length) {
    return "";
  }
  return `
    <div class="agile-children">
      ${children.map((child) => renderProjectCard(child, depth)).join("")}
    </div>
  `;
}

function renderProjectEditorForm(project) {
  const isExisting = Boolean(state.selectedProjectId && project?.project_id);
  return `
    <div class="editor-grid">
      <section class="editor-section">
        <div class="editor-toolbar">
          <div>
            <p class="section-label">Project identity</p>
            <h4>Project basics</h4>
          </div>
        </div>
        <div class="editor-row">
          ${renderField("Project key", "project_id", project.project_id || "", {
            placeholder: "team-ops-platform",
            disabled: isExisting,
          })}
          ${renderField("Status", "status", project.status || "active", {
            type: "select",
            options: projectStatusOptions(),
          })}
        </div>
        <div class="editor-row">
          ${renderField("Project name", "name", project.name || "", {
            placeholder: "Operations planning workspace",
            required: true,
          })}
        </div>
        ${renderField("Description", "description", project.description || "", {
          type: "textarea",
          placeholder: "Capture the purpose of this project, the intended outcome, and any important guardrails.",
        })}
      </section>
    </div>
  `;
}

function renderItemEditorForm({ itemDraft, items, projectDraft }) {
  if (!projectDraft || !state.selectedProjectId) {
    return `<div class="empty-state">Select a project first so items have somewhere to live.</div>`;
  }
  if (!itemDraft) {
    return `<div class="empty-state">Select an item on the board or create a new epic, story, or task.</div>`;
  }

  const isExisting = Boolean(state.selectedItemId && itemDraft.item_id);
  const parentOptions = itemParentOptions(items, itemDraft);
  return `
    <div class="editor-grid">
      <section class="editor-section">
        <div class="editor-toolbar">
          <div>
            <p class="section-label">Work item</p>
            <h4>Story details and acceptance criteria</h4>
          </div>
        </div>
        <div class="editor-row editor-row--quad">
          ${renderField("Item key", "item_id", itemDraft.item_id || "", {
            placeholder: "story-key",
            disabled: isExisting,
          })}
          ${renderField("Type", "item_type", itemDraft.item_type || "story", {
            type: "select",
            options: itemTypeOptions(),
          })}
          ${renderField("State", "status", itemDraft.status || "new", {
            type: "select",
            options: itemStatusOptions(),
          })}
          ${renderField("Priority", "priority", itemDraft.priority || "medium", {
            type: "select",
            options: priorityOptions(),
          })}
        </div>
        <div class="editor-row">
          ${renderField("Title", "title", itemDraft.title || "", {
            placeholder: "As a user, I can ...",
            required: true,
          })}
          ${renderField("Parent", "parent_id", itemDraft.parent_id || "", {
            type: "select",
            options: parentOptions,
          })}
        </div>
        <div class="editor-row editor-row--triple">
          ${renderField("Rank", "rank", valueOrEmpty(itemDraft.rank ?? 100), { type: "number" })}
          ${renderField("Assignees", "assignee_emails", joinList(itemDraft.assignee_emails || []), {
            valueType: "csv",
            placeholder: "user@example.com",
          })}
          ${renderField("Tags", "tags", joinList(itemDraft.tags || []), {
            valueType: "csv",
            placeholder: "ui, backend, aws",
          })}
        </div>
        ${renderField("Summary", "summary", itemDraft.summary || "", {
          type: "textarea",
          placeholder: "Short planning note or implementation summary.",
        })}
        ${renderField("User story", "user_story", itemDraft.user_story || "", {
          type: "textarea",
          placeholder: "As a ..., I want ..., so that ...",
        })}
        ${renderField("Acceptance criteria", "acceptance_criteria", (itemDraft.acceptance_criteria || []).join("\n"), {
          type: "textarea",
          valueType: "lines",
          placeholder: "One acceptance criterion per line",
        })}
      </section>
    </div>
  `;
}

function handleProjectEditorInput(event) {
  const control = event.target;
  const path = control.dataset.fieldPath;
  if (!path || !state.projectDraft) {
    return;
  }
  setNestedValue(state.projectDraft, path, readControlValue(control));
}

function handleItemEditorInput(event) {
  const control = event.target;
  const path = control.dataset.fieldPath;
  if (!path || !state.itemDraft) {
    return;
  }
  setNestedValue(state.itemDraft, path, readControlValue(control));
  if (path === "item_type") {
    const options = itemParentOptions(selectedProjectDetail()?.items || [], state.itemDraft);
    if (!options.some((option) => option.value === state.itemDraft.parent_id)) {
      state.itemDraft.parent_id = "";
    }
    renderWorkspace();
  }
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
  setEditorFeedback(elements.projectFeedback, "Loading project...", "");
  try {
    await loadProjectDetail(projectId, { force: false });
    setEditorFeedback(elements.projectFeedback, "Project loaded.", "");
  } catch (error) {
    console.error(error);
    setEditorFeedback(elements.projectFeedback, error.message || "Could not load the project.", "is-error");
  }
  renderAll();
}

function handleBoardClick(event) {
  const button = event.target.closest("[data-item-select]");
  if (!button) {
    return;
  }
  const itemId = button.dataset.itemSelect;
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
  renderWorkspace();
}

function beginCreateProject() {
  state.selectedProjectId = null;
  state.selectedItemId = null;
  state.projectDraft = buildBlankProjectDraft();
  state.itemDraft = null;
  setEditorFeedback(elements.projectFeedback, "New project draft opened.", "");
  renderAll();
}

function beginCreateItem(itemType) {
  if (!state.selectedProjectId) {
    setEditorFeedback(elements.projectFeedback, "Select a project first so the new item has a home.", "is-error");
    return;
  }
  const parentId = suggestedParentId(itemType);
  state.itemDraft = buildBlankItemDraft(state.selectedProjectId, itemType, parentId);
  state.selectedItemId = null;
  setEditorFeedback(elements.projectFeedback, `New ${formatItemType(itemType).toLowerCase()} draft opened.`, "");
  renderWorkspace();
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

  setEditorFeedback(elements.projectFeedback, creating ? "Creating project..." : "Saving project...", "");
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
    renderAll();
    setEditorFeedback(elements.projectFeedback, creating ? "Project created." : "Project changes saved.", "is-success");
  } catch (error) {
    console.error(error);
    setEditorFeedback(elements.projectFeedback, error.message || "Could not save the project.", "is-error");
  }
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

  setEditorFeedback(elements.projectFeedback, creating ? "Creating item..." : "Saving item...", "");
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
    renderAll();
    setEditorFeedback(elements.projectFeedback, creating ? "Work item created." : "Work item changes saved.", "is-success");
  } catch (error) {
    console.error(error);
    setEditorFeedback(elements.projectFeedback, error.message || "Could not save the work item.", "is-error");
  }
}

async function deleteSelectedProject() {
  if (!state.selectedProjectId) {
    return;
  }
  const confirmed = window.confirm("Delete this project and all of its work items?");
  if (!confirmed) {
    return;
  }
  setEditorFeedback(elements.projectFeedback, "Deleting project...", "");
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
    await loadProjects({ preserveSelection: false });
    if (state.selectedProjectId) {
      await loadProjectDetail(state.selectedProjectId, { force: true });
    }
    renderAll();
    setEditorFeedback(elements.projectFeedback, "Project deleted.", "is-success");
  } catch (error) {
    console.error(error);
    setEditorFeedback(elements.projectFeedback, error.message || "Could not delete the project.", "is-error");
  }
}

async function deleteSelectedItem() {
  if (!state.selectedProjectId || !state.selectedItemId) {
    return;
  }
  const confirmed = window.confirm("Delete this item and any child items under it?");
  if (!confirmed) {
    return;
  }
  setEditorFeedback(elements.projectFeedback, "Deleting item...", "");
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
    renderAll();
    setEditorFeedback(elements.projectFeedback, "Work item deleted.", "is-success");
  } catch (error) {
    console.error(error);
    setEditorFeedback(elements.projectFeedback, error.message || "Could not delete the work item.", "is-error");
  }
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

function renderField(label, path, value, options = {}) {
  const {
    type = "text",
    valueType = type === "number" ? "int" : "string",
    placeholder = "",
    required = false,
    step = "1",
    disabled = false,
    options: selectOptions = [],
  } = options;

  const controlAttributes = [
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
      <label class="field field--full">
        <span>${escapeHtml(label)}</span>
        <textarea ${controlAttributes}>${escapeHtml(value ?? "")}</textarea>
      </label>
    `;
  }

  if (type === "select") {
    return `
      <label class="field">
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
    <label class="field">
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

function setEditorFeedback(element, message, className) {
  element.textContent = message || "";
  element.className = `detail-feedback ${className || ""}`.trim();
}

function setBanner(message) {
  elements.statusBanner.textContent = message || "";
}

function renderPill(label, options = {}) {
  const modifiers = [];
  if (options.status) {
    modifiers.push(`pill--status-${String(options.status).replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`);
  }
  if (options.type) {
    modifiers.push(`pill--type-${String(options.type).replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`);
  }
  if (options.priority) {
    modifiers.push(`pill--priority-${String(options.priority).replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`);
  }
  if (options.kind) {
    modifiers.push(`pill--${String(options.kind).replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`);
  }
  return `<span class="pill ${modifiers.join(" ")}">${escapeHtml(label)}</span>`;
}

function showAuthGate(message) {
  setVisibility(elements.authGate, true, "grid");
  setVisibility(elements.portalShell, false, "grid");
  elements.authStatus.textContent = message;
}

function showPortal() {
  setVisibility(elements.authGate, false, "grid");
  setVisibility(elements.portalShell, true, "grid");
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
