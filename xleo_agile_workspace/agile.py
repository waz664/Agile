from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any


AGILE_PROJECT_STATUSES = ("active", "archived")
AGILE_ITEM_TYPES = ("epic", "story", "task")
AGILE_ITEM_STATUSES = ("new", "backlog", "implementing", "done")
AGILE_ITEM_PRIORITIES = ("low", "medium", "high", "critical")


@dataclass(frozen=True, slots=True)
class AgileProject:
    project_id: str
    name: str
    description: str = ""
    status: str = "active"
    created_at_utc: datetime = field(default_factory=lambda: datetime.now(UTC))
    updated_at_utc: datetime = field(default_factory=lambda: datetime.now(UTC))

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "AgileProject":
        project_id = _required_text(payload.get("project_id", payload.get("projectId")), "project_id")
        name = _required_text(payload.get("name"), "name")
        status = _normalize_choice(
            payload.get("status", "active"),
            field_name="status",
            allowed_values=AGILE_PROJECT_STATUSES,
        )
        created_at = _coerce_datetime(payload.get("created_at_utc", payload.get("createdAtUtc")))
        updated_at = _coerce_datetime(payload.get("updated_at_utc", payload.get("updatedAtUtc")))
        reference_time = datetime.now(UTC)
        return cls(
            project_id=project_id,
            name=name,
            description=_optional_text(payload.get("description")) or "",
            status=status,
            created_at_utc=created_at or reference_time,
            updated_at_utc=updated_at or created_at or reference_time,
        )


@dataclass(frozen=True, slots=True)
class AgileWorkItem:
    item_id: str
    project_id: str
    title: str
    item_type: str = "story"
    status: str = "new"
    summary: str = ""
    user_story: str = ""
    acceptance_criteria: tuple[str, ...] = ()
    parent_id: str | None = None
    priority: str = "medium"
    assignee_emails: tuple[str, ...] = ()
    tags: tuple[str, ...] = ()
    rank: int = 100
    created_at_utc: datetime = field(default_factory=lambda: datetime.now(UTC))
    updated_at_utc: datetime = field(default_factory=lambda: datetime.now(UTC))

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "AgileWorkItem":
        item_id = _required_text(payload.get("item_id", payload.get("itemId")), "item_id")
        project_id = _required_text(payload.get("project_id", payload.get("projectId")), "project_id")
        title = _required_text(payload.get("title"), "title")
        item_type = _normalize_choice(
            payload.get("item_type", payload.get("itemType", "story")),
            field_name="item_type",
            allowed_values=AGILE_ITEM_TYPES,
        )
        status = _normalize_choice(
            payload.get("status", "new"),
            field_name="status",
            allowed_values=AGILE_ITEM_STATUSES,
        )
        priority = _normalize_choice(
            payload.get("priority", "medium"),
            field_name="priority",
            allowed_values=AGILE_ITEM_PRIORITIES,
        )
        acceptance_criteria = tuple(
            str(value).strip()
            for value in (payload.get("acceptance_criteria", payload.get("acceptanceCriteria")) or [])
            if str(value).strip()
        )
        assignee_emails = tuple(
            str(value).strip()
            for value in (payload.get("assignee_emails", payload.get("assigneeEmails")) or [])
            if str(value).strip()
        )
        tags = tuple(
            str(value).strip()
            for value in (payload.get("tags") or [])
            if str(value).strip()
        )
        created_at = _coerce_datetime(payload.get("created_at_utc", payload.get("createdAtUtc")))
        updated_at = _coerce_datetime(payload.get("updated_at_utc", payload.get("updatedAtUtc")))
        reference_time = datetime.now(UTC)
        return cls(
            item_id=item_id,
            project_id=project_id,
            title=title,
            item_type=item_type,
            status=status,
            summary=_optional_text(payload.get("summary")) or "",
            user_story=_optional_text(payload.get("user_story", payload.get("userStory"))) or "",
            acceptance_criteria=acceptance_criteria,
            parent_id=_optional_text(payload.get("parent_id", payload.get("parentId"))),
            priority=priority,
            assignee_emails=assignee_emails,
            tags=tags,
            rank=int(payload.get("rank", 100)),
            created_at_utc=created_at or reference_time,
            updated_at_utc=updated_at or created_at or reference_time,
        )


def serialize_agile_project(project: AgileProject) -> dict[str, Any]:
    return {
        "projectId": project.project_id,
        "name": project.name,
        "description": project.description,
        "status": project.status,
        "createdAtUtc": project.created_at_utc.isoformat(),
        "updatedAtUtc": project.updated_at_utc.isoformat(),
    }


def serialize_agile_work_item(item: AgileWorkItem) -> dict[str, Any]:
    return {
        "itemId": item.item_id,
        "projectId": item.project_id,
        "title": item.title,
        "itemType": item.item_type,
        "status": item.status,
        "summary": item.summary,
        "userStory": item.user_story,
        "acceptanceCriteria": list(item.acceptance_criteria),
        "parentId": item.parent_id,
        "priority": item.priority,
        "assigneeEmails": list(item.assignee_emails),
        "tags": list(item.tags),
        "rank": item.rank,
        "createdAtUtc": item.created_at_utc.isoformat(),
        "updatedAtUtc": item.updated_at_utc.isoformat(),
    }


def validate_parent_relationship(
    *,
    parent: AgileWorkItem | None,
    child: AgileWorkItem,
) -> None:
    if child.parent_id is None:
        return
    if parent is None:
        raise ValueError(f"Parent item not found: {child.parent_id}")
    if parent.project_id != child.project_id:
        raise ValueError("Parent item must belong to the same project.")
    if parent.item_id == child.item_id:
        raise ValueError("An item cannot be its own parent.")
    allowed_children = {
        "epic": {"story", "task"},
        "story": {"task"},
        "task": set(),
    }
    if child.item_type not in allowed_children[parent.item_type]:
        raise ValueError(
            f"Cannot place a {child.item_type} under a {parent.item_type}."
        )


def build_agile_board(
    project: AgileProject,
    items: tuple[AgileWorkItem, ...],
) -> dict[str, Any]:
    serialized_items = [serialize_agile_work_item(item) for item in _sort_items(items)]
    roots = _build_item_forest(serialized_items)

    columns: list[dict[str, Any]] = []
    for status in AGILE_ITEM_STATUSES:
        items_for_status, item_count = _build_status_lane_items(serialized_items, status)
        columns.append(
            {
                "status": status,
                "label": _status_label(status),
                "count": item_count,
                "items": items_for_status,
            }
        )

    return {
        "project": serialize_agile_project(project),
        "columns": columns,
        "rootItems": roots,
        "itemCount": len(serialized_items),
    }


def _build_item_forest(serialized_items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    nodes = {item["itemId"]: {**item, "children": []} for item in serialized_items}
    roots: list[dict[str, Any]] = []
    for item in serialized_items:
        node = nodes[item["itemId"]]
        parent = nodes.get(item.get("parentId"))
        if parent:
            parent["children"].append(node)
        else:
            roots.append(node)
    return roots


def _build_status_lane_items(
    serialized_items: list[dict[str, Any]],
    status: str,
) -> tuple[list[dict[str, Any]], int]:
    lane_items = [item for item in serialized_items if item["status"] == status]
    nodes = {item["itemId"]: {**item, "children": []} for item in lane_items}
    roots: list[dict[str, Any]] = []
    for item in lane_items:
        node = nodes[item["itemId"]]
        parent = nodes.get(item.get("parentId"))
        if parent:
            parent["children"].append(node)
        else:
            roots.append(node)
    return roots, len(lane_items)


def _sort_items(items: tuple[AgileWorkItem, ...]) -> tuple[AgileWorkItem, ...]:
    return tuple(
        sorted(
            items,
            key=lambda item: (
                AGILE_ITEM_STATUSES.index(item.status),
                item.rank,
                0 if item.item_type == "epic" else 1 if item.item_type == "story" else 2,
                item.updated_at_utc.isoformat(),
                item.title.lower(),
            ),
        )
    )


def _status_label(value: str) -> str:
    return {
        "new": "New",
        "backlog": "Backlog",
        "implementing": "Implementing",
        "done": "Done",
    }[value]


def _coerce_datetime(value: Any) -> datetime | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    normalized = text.replace("Z", "+00:00")
    if len(normalized) >= 5 and normalized[-5] in {"+", "-"} and ":" not in normalized[-5:]:
        normalized = f"{normalized[:-2]}:{normalized[-2:]}"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _normalize_choice(
    value: Any,
    *,
    field_name: str,
    allowed_values: tuple[str, ...],
) -> str:
    text = _required_text(value, field_name).lower()
    if text not in allowed_values:
        raise ValueError(
            f"{field_name} must be one of {', '.join(allowed_values)}."
        )
    return text


def _required_text(value: Any, field_name: str) -> str:
    text = _optional_text(value)
    if text is None:
        raise ValueError(f"{field_name} is required")
    return text


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None
