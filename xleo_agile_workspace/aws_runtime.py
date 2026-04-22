from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
from dataclasses import dataclass, field
from datetime import UTC, datetime
from importlib.resources import files
from typing import Any
from urllib.parse import unquote

from .agile import (
    AGILE_ITEM_STATUSES,
    AgileProject,
    AgileWorkItem,
    build_agile_board,
    serialize_agile_project,
    serialize_agile_work_item,
    validate_parent_relationship,
)


@dataclass(frozen=True, slots=True)
class PortalUserContext:
    email: str
    display_name: str
    groups: tuple[str, ...]
    is_super_admin: bool
    allowed_project_ids: tuple[str, ...] = ()


SERVICE_API_KEY_STATUSES = ("active", "revoked")
SERVICE_API_KEY_PK = "CONFIG#SERVICE_API_KEYS"
SERVICE_API_KEY_TOKEN_PATTERN = re.compile(r"^agws_([a-f0-9]{12})_([A-Za-z0-9\-_]{24,})$")


@dataclass(frozen=True, slots=True)
class ServiceApiKeyRecord:
    key_id: str
    label: str
    secret_hash: str
    key_preview: str
    allowed_project_ids: tuple[str, ...] = ()
    status: str = "active"
    created_at_utc: datetime = field(default_factory=lambda: datetime.now(UTC))
    updated_at_utc: datetime = field(default_factory=lambda: datetime.now(UTC))
    last_used_at_utc: datetime | None = None

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "ServiceApiKeyRecord":
        key_id = _required_text(payload.get("key_id", payload.get("keyId")), "key_id")
        secret_hash = _required_text(payload.get("secret_hash", payload.get("secretHash")), "secret_hash")
        status = _normalize_choice(
            payload.get("status", "active"),
            field_name="status",
            allowed_values=SERVICE_API_KEY_STATUSES,
        )
        allowed_project_ids = _normalize_project_id_list(
            payload.get("allowed_project_ids", payload.get("allowedProjectIds"))
        )
        reference_time = datetime.now(UTC)
        created_at = _coerce_datetime(payload.get("created_at_utc", payload.get("createdAtUtc")))
        updated_at = _coerce_datetime(payload.get("updated_at_utc", payload.get("updatedAtUtc")))
        last_used_at = _coerce_datetime(payload.get("last_used_at_utc", payload.get("lastUsedAtUtc")))
        return cls(
            key_id=key_id,
            label=_optional_text(payload.get("label")) or "Codex integration",
            secret_hash=secret_hash,
            key_preview=_optional_text(payload.get("key_preview", payload.get("keyPreview"))) or f"agws_{key_id}_...",
            allowed_project_ids=allowed_project_ids,
            status=status,
            created_at_utc=created_at or reference_time,
            updated_at_utc=updated_at or created_at or reference_time,
            last_used_at_utc=last_used_at,
        )


class ConflictError(Exception):
    pass


def lambda_handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    method = str(_event_value(event, "requestContext", "http", "method") or "GET").upper()
    path = str(event.get("rawPath") or event.get("path") or "/")
    body = _decode_event_body(event)

    try:
        if method == "GET" and path in {"/", "/index.html", "/auth/callback"}:
            return _static_asset_response("index.html", "text/html; charset=utf-8")
        if method == "GET" and path == "/app.js":
            return _static_asset_response("app.js", "application/javascript; charset=utf-8")
        if method == "GET" and path == "/styles.css":
            return _static_asset_response("styles.css", "text/css; charset=utf-8")
        if method == "GET" and path == "/app-config.js":
            return text_response(
                200,
                build_portal_app_config_payload(),
                headers={"content-type": "application/javascript; charset=utf-8"},
            )
        if method == "GET" and path == "/health":
            return response(
                200,
                {
                    "ok": True,
                    "project": os.environ.get("PROJECT_NAME", "xleo-agile-workspace"),
                    "environment": os.environ.get("ENVIRONMENT_NAME", "dev"),
                    "table": os.environ.get("AGILE_STATE_TABLE", "unknown"),
                    "time": datetime.now(UTC).isoformat(),
                },
            )
        if path.startswith("/api/"):
            return handle_api_request(event=event, body=body, method=method, path=path)
        if path.startswith("/service/"):
            return handle_service_api_request(event=event, body=body, method=method, path=path)
        if method == "GET" and "." not in path.rsplit("/", 1)[-1]:
            return _static_asset_response("index.html", "text/html; charset=utf-8")
        return response(404, {"ok": False, "error": f"Route not found: {method} {path}"})
    except PermissionError as error:
        return response(403, {"ok": False, "error": str(error)})
    except KeyError as error:
        return response(404, {"ok": False, "error": str(error)})
    except ConflictError as error:
        return response(409, {"ok": False, "error": str(error)})
    except ValueError as error:
        return response(400, {"ok": False, "error": str(error)})
    except Exception as error:  # pragma: no cover
        return response(500, {"ok": False, "error": f"Unexpected runtime error: {error}"})


def handle_api_request(
    *,
    event: dict[str, Any],
    body: dict[str, Any],
    method: str,
    path: str,
) -> dict[str, Any]:
    user = resolve_portal_user(event)

    if method == "GET" and path == "/api/session":
        return response(
            200,
            {
                "ok": True,
                "session": build_portal_session_payload(user),
                "time": datetime.now(UTC).isoformat(),
            },
        )

    store = _build_store()

    if method == "GET" and path == "/api/service-keys":
        require_portal_permission(user, "agile.manage")
        return response(
            200,
            {
                "ok": True,
                "serviceKeys": [serialize_service_api_key(item) for item in store.list_service_api_keys()],
                "time": datetime.now(UTC).isoformat(),
            },
        )

    if method == "POST" and path == "/api/service-keys":
        require_portal_permission(user, "agile.manage")
        return response(200, create_service_api_key_from_payload(store=store, body=body))

    service_key_id = _path_match(path, r"^/api/service-keys/([^/]+)$")
    if service_key_id and method == "DELETE":
        require_portal_permission(user, "agile.manage")
        return response(200, revoke_service_api_key_from_payload(store=store, key_id=service_key_id))

    return handle_agile_request(
        event=event,
        store=store,
        user=user,
        body=body,
        method=method,
        path=path,
        path_prefix="/api",
    )


def handle_service_api_request(
    *,
    event: dict[str, Any],
    body: dict[str, Any],
    method: str,
    path: str,
) -> dict[str, Any]:
    store = _build_store()
    user = resolve_service_api_key_user(event=event, store=store)
    return handle_agile_request(
        event=event,
        store=store,
        user=user,
        body=body,
        method=method,
        path=path,
        path_prefix="/service",
    )


def _build_store() -> "DynamoDbAgileStore":
    return DynamoDbAgileStore(
        table_name=os.environ["AGILE_STATE_TABLE"],
        region_name=os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION"),
    )


def handle_agile_request(
    *,
    event: dict[str, Any],
    store: "DynamoDbAgileStore",
    user: PortalUserContext,
    body: dict[str, Any],
    method: str,
    path: str,
    path_prefix: str,
) -> dict[str, Any]:
    escaped_prefix = re.escape(path_prefix)

    if method == "GET" and path == f"{path_prefix}/agile/projects":
        include_archived = _query_string_value(event, "includeArchived", "include_archived") in {"true", "1", "yes"}
        limit = _optional_int(_query_string_value(event, "limit")) or 50
        store_limit = max(1, limit) if not user.allowed_project_ids else 500
        projects = tuple(
            project
            for project in store.list_agile_projects(limit=store_limit, include_archived=include_archived)
            if _user_can_access_project(user, project.project_id)
        )[: max(1, limit)]
        return response(
            200,
            {
                "ok": True,
                "projects": [
                    summarize_agile_project(project, store.list_agile_items(project.project_id))
                    for project in projects
                ],
                "permissions": build_portal_permissions(user),
                "time": datetime.now(UTC).isoformat(),
            },
        )

    if method == "POST" and path == f"{path_prefix}/agile/projects":
        require_portal_permission(user, "agile.manage")
        _ensure_project_access(user, _project_id_from_body(body))
        return response(
            200,
            upsert_agile_project_from_payload(store=store, body=body, allow_create=True),
        )

    project_id = _path_match(path, rf"^{escaped_prefix}/agile/projects/([^/]+)$")
    if project_id:
        _ensure_project_access(user, project_id)
        if method == "GET":
            return response(
                200,
                {
                    "ok": True,
                    **build_agile_project_detail_response_payload(store=store, project_id=project_id),
                    "permissions": build_portal_permissions(user),
                    "time": datetime.now(UTC).isoformat(),
                },
            )
        if method == "PUT":
            require_portal_permission(user, "agile.manage")
            return response(
                200,
                upsert_agile_project_from_payload(
                    store=store,
                    body=body,
                    allow_create=False,
                    expected_project_id=project_id,
                ),
            )
        if method == "DELETE":
            require_portal_permission(user, "agile.manage")
            return response(
                200,
                delete_agile_project_from_payload(store=store, project_id=project_id),
            )

    project_items_id = _path_match(path, rf"^{escaped_prefix}/agile/projects/([^/]+)/items$")
    if project_items_id:
        _ensure_project_access(user, project_items_id)
        if method == "GET":
            items = store.list_agile_items(project_items_id)
            return response(
                200,
                {
                    "ok": True,
                    "project": serialize_agile_project(store.load_agile_project(project_items_id)),
                    "items": [serialize_agile_work_item(item) for item in items],
                    "count": len(items),
                    "permissions": build_portal_permissions(user),
                    "time": datetime.now(UTC).isoformat(),
                },
            )
        if method == "POST":
            require_portal_permission(user, "agile.manage")
            return response(
                200,
                upsert_agile_work_item_from_payload(
                    store=store,
                    project_id=project_items_id,
                    body=body,
                    allow_create=True,
                ),
            )

    item_match = re.match(rf"^{escaped_prefix}/agile/projects/([^/]+)/items/([^/]+)$", path)
    if item_match:
        project_id = unquote(item_match.group(1))
        item_id = unquote(item_match.group(2))
        _ensure_project_access(user, project_id)
        if method == "GET":
            item = store.load_agile_item(project_id, item_id)
            return response(
                200,
                {
                    "ok": True,
                    "project": serialize_agile_project(store.load_agile_project(project_id)),
                    "item": serialize_agile_work_item(item),
                    "permissions": build_portal_permissions(user),
                    "time": datetime.now(UTC).isoformat(),
                },
            )
        if method == "PUT":
            require_portal_permission(user, "agile.manage")
            return response(
                200,
                upsert_agile_work_item_from_payload(
                    store=store,
                    project_id=project_id,
                    body=body,
                    allow_create=False,
                    expected_item_id=item_id,
                ),
            )
        if method == "DELETE":
            require_portal_permission(user, "agile.manage")
            return response(
                200,
                delete_agile_item_from_payload(store=store, project_id=project_id, item_id=item_id),
            )

    return response(404, {"ok": False, "error": f"Route not found: {method} {path}"})


def response(
    status_code: int,
    payload: dict[str, Any],
    headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    response_headers = {
        "cache-control": "no-store",
        "content-type": "application/json",
    }
    if headers:
        response_headers.update(headers)
    return {
        "statusCode": status_code,
        "headers": response_headers,
        "body": json.dumps(payload),
    }


def text_response(
    status_code: int,
    text: str,
    headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    response_headers = {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
    }
    if headers:
        response_headers.update(headers)
    return {
        "statusCode": status_code,
        "headers": response_headers,
        "body": text,
    }


def _static_asset_response(asset_name: str, content_type: str) -> dict[str, Any]:
    asset = build_static_portal_asset(asset_name)
    return {
        "statusCode": 200,
        "headers": {
            "cache-control": "no-store",
            "content-type": content_type,
        },
        "body": asset.decode("utf-8"),
    }


def build_static_portal_asset(asset_name: str) -> bytes:
    asset_path = files("xleo_agile_workspace").joinpath("portal_assets", asset_name)
    return asset_path.read_bytes()


def build_portal_app_config_payload() -> str:
    auth_mode = "cognito" if os.environ.get("PORTAL_COGNITO_CLIENT_ID") else "none"
    config = {
        "authMode": auth_mode,
        "apiBaseUrl": "/api",
        "appTitle": os.environ.get("PORTAL_TITLE", "XLEO Agile Workspace"),
        "cognito": {
            "clientId": os.environ.get("PORTAL_COGNITO_CLIENT_ID", ""),
            "domain": os.environ.get("PORTAL_COGNITO_DOMAIN", ""),
            "scopes": ["openid", "email", "profile"],
            "redirectPath": "/auth/callback",
            "logoutPath": "/",
        },
    }
    return f"window.AGILE_WORKSPACE_CONFIG = {json.dumps(config)};"


def build_portal_session_payload(user: PortalUserContext) -> dict[str, Any]:
    return {
        "app": {
            "title": os.environ.get("PORTAL_TITLE", "XLEO Agile Workspace"),
            "subtitle": os.environ.get(
                "PORTAL_SUBTITLE",
                "AWS-hosted agile planning for projects, stories, and acceptance criteria.",
            ),
        },
        "user": {
            "email": user.email,
            "displayName": user.display_name,
            "groups": list(user.groups),
            "isSuperAdmin": user.is_super_admin,
            "roleLabel": "Super Admin" if user.is_super_admin else "Workspace Member",
        },
        "permissions": build_portal_permissions(user),
    }


def build_portal_permissions(user: PortalUserContext) -> dict[str, Any]:
    return {
        "agileView": True,
        "agileManage": user.is_super_admin,
        "allowedProjectIds": list(user.allowed_project_ids),
    }


def resolve_portal_user(event: dict[str, Any]) -> PortalUserContext:
    allowed_emails = _parse_email_set(os.environ.get("PORTAL_ALLOWED_EMAILS", ""))
    if not allowed_emails:
        raise PermissionError("Portal access is not enabled.")

    claims = _event_value(event, "requestContext", "authorizer", "jwt", "claims") or {}
    if not isinstance(claims, dict):
        claims = {}

    email = _optional_text(claims.get("email"))
    if not email:
        raise PermissionError("Missing authenticated user email.")
    normalized_email = email.lower()
    if normalized_email not in allowed_emails:
        raise PermissionError("Portal access is not enabled for this user.")

    name = (
        _optional_text(claims.get("name"))
        or _optional_text(claims.get("cognito:username"))
        or normalized_email
    )
    groups = _normalize_groups(claims.get("cognito:groups"))
    super_admins = _parse_email_set(os.environ.get("PORTAL_SUPER_ADMIN_EMAILS", ""))

    return PortalUserContext(
        email=normalized_email,
        display_name=name,
        groups=groups,
        is_super_admin=normalized_email in super_admins,
    )


def resolve_service_api_key_user(
    *,
    event: dict[str, Any],
    store: "DynamoDbAgileStore",
) -> PortalUserContext:
    token = _header_value(event, "x-api-key")
    if not token:
        raise PermissionError("Missing service API key.")

    key_id, secret = _parse_service_api_key_token(token)
    record = store.try_load_service_api_key(key_id)
    if record is None or record.status != "active":
        raise PermissionError("Service API key is invalid or disabled.")
    if not secrets.compare_digest(record.secret_hash, _hash_service_api_key_secret(secret)):
        raise PermissionError("Service API key is invalid or disabled.")

    store.touch_service_api_key_usage(key_id)
    return PortalUserContext(
        email=f"service-key:{record.key_id}",
        display_name=record.label,
        groups=("service",),
        is_super_admin=True,
        allowed_project_ids=record.allowed_project_ids,
    )


def require_portal_permission(user: PortalUserContext, permission_key: str) -> None:
    permissions = build_portal_permissions(user)
    permission_map = {
        "agile.manage": "agileManage",
        "agile.view": "agileView",
    }
    resolved_key = permission_map.get(permission_key, permission_key)
    if not permissions.get(resolved_key):
        raise PermissionError("You do not have permission to manage agile projects in this workspace.")


def serialize_service_api_key(
    record: ServiceApiKeyRecord,
    *,
    include_secret_hash: bool = False,
) -> dict[str, Any]:
    payload = {
        "keyId": record.key_id,
        "label": record.label,
        "status": record.status,
        "keyPreview": record.key_preview,
        "allowedProjectIds": list(record.allowed_project_ids),
        "createdAtUtc": record.created_at_utc.isoformat(),
        "updatedAtUtc": record.updated_at_utc.isoformat(),
        "lastUsedAtUtc": record.last_used_at_utc.isoformat() if record.last_used_at_utc else None,
    }
    if include_secret_hash:
        payload["secretHash"] = record.secret_hash
    return payload


def create_service_api_key_from_payload(
    *,
    store: "DynamoDbAgileStore",
    body: dict[str, Any],
) -> dict[str, Any]:
    payload = body.get("serviceKey") if isinstance(body.get("serviceKey"), dict) else body
    if payload and not isinstance(payload, dict):
        raise ValueError("Service key payload must be an object.")

    key_label = _optional_text((payload or {}).get("label")) or "Codex integration"
    allowed_project_ids = _normalize_project_id_list(
        (payload or {}).get("allowed_project_ids", (payload or {}).get("allowedProjectIds"))
    )
    key_id, plaintext_key, key_preview, secret_hash = _generate_service_api_key_material(store=store)
    now = datetime.now(UTC)
    record = ServiceApiKeyRecord(
        key_id=key_id,
        label=key_label,
        status="active",
        key_preview=key_preview,
        secret_hash=secret_hash,
        allowed_project_ids=allowed_project_ids,
        created_at_utc=now,
        updated_at_utc=now,
        last_used_at_utc=None,
    )
    store.save_service_api_key(record)
    return {
        "ok": True,
        "serviceKey": serialize_service_api_key(record),
        "plaintextKey": plaintext_key,
    }


def revoke_service_api_key_from_payload(
    *,
    store: "DynamoDbAgileStore",
    key_id: str,
) -> dict[str, Any]:
    existing = store.load_service_api_key(key_id)
    if existing.status == "revoked":
        return {
            "ok": True,
            "serviceKey": serialize_service_api_key(existing),
        }

    now = datetime.now(UTC)
    revoked = ServiceApiKeyRecord(
        key_id=existing.key_id,
        label=existing.label,
        status="revoked",
        key_preview=existing.key_preview,
        secret_hash=existing.secret_hash,
        allowed_project_ids=existing.allowed_project_ids,
        created_at_utc=existing.created_at_utc,
        updated_at_utc=now,
        last_used_at_utc=existing.last_used_at_utc,
    )
    store.save_service_api_key(revoked)
    return {
        "ok": True,
        "serviceKey": serialize_service_api_key(revoked),
    }


def summarize_agile_project(
    project: AgileProject,
    items: tuple[AgileWorkItem, ...],
) -> dict[str, Any]:
    counts_by_status = {
        status: sum(1 for item in items if item.status == status)
        for status in AGILE_ITEM_STATUSES
    }
    counts_by_type = {
        item_type: sum(1 for item in items if item.item_type == item_type)
        for item_type in ("epic", "story", "task")
    }
    return {
        **serialize_agile_project(project),
        "itemCount": len(items),
        "countsByStatus": counts_by_status,
        "countsByType": counts_by_type,
    }


def build_agile_project_detail_response_payload(
    *,
    store: "DynamoDbAgileStore",
    project_id: str,
) -> dict[str, Any]:
    project = store.load_agile_project(project_id)
    items = store.list_agile_items(project_id)
    return {
        "project": summarize_agile_project(project, items),
        "projectConfig": serialize_agile_project(project),
        "board": build_agile_board(project, items),
        "items": [serialize_agile_work_item(item) for item in items],
    }


def upsert_agile_project_from_payload(
    *,
    store: "DynamoDbAgileStore",
    body: dict[str, Any],
    allow_create: bool,
    expected_project_id: str | None = None,
) -> dict[str, Any]:
    payload = body.get("project") if isinstance(body.get("project"), dict) else body
    if not isinstance(payload, dict):
        raise ValueError("Project payload must be an object.")

    project_payload = dict(payload)
    project_id = _optional_text(project_payload.get("project_id", project_payload.get("projectId")))
    if expected_project_id:
        project_id = expected_project_id
        project_payload["project_id"] = expected_project_id
    if project_id is None:
        project_id = _slugify(_required_text(project_payload.get("name"), "name"))
        project_payload["project_id"] = project_id

    existing_project = store.try_load_agile_project(project_id)
    if existing_project is None and not allow_create:
        raise KeyError(f"Agile project not found: {project_id}")
    if existing_project is not None and allow_create and expected_project_id is None:
        raise ConflictError(f"Agile project already exists: {project_id}")

    now = datetime.now(UTC)
    project_payload["created_at_utc"] = (
        existing_project.created_at_utc.isoformat() if existing_project else now.isoformat()
    )
    project_payload["updated_at_utc"] = now.isoformat()
    project = AgileProject.from_dict(project_payload)
    store.save_agile_project(project)

    return {
        "ok": True,
        "projectCreated": existing_project is None,
        **build_agile_project_detail_response_payload(store=store, project_id=project.project_id),
    }


def upsert_agile_work_item_from_payload(
    *,
    store: "DynamoDbAgileStore",
    project_id: str,
    body: dict[str, Any],
    allow_create: bool,
    expected_item_id: str | None = None,
) -> dict[str, Any]:
    payload = body.get("item") if isinstance(body.get("item"), dict) else body
    if not isinstance(payload, dict):
        raise ValueError("Item payload must be an object.")

    store.load_agile_project(project_id)
    item_payload = dict(payload)
    item_payload["project_id"] = project_id

    item_id = _optional_text(item_payload.get("item_id", item_payload.get("itemId")))
    if expected_item_id:
        item_id = expected_item_id
        item_payload["item_id"] = expected_item_id
    if item_id is None:
        item_id = _slugify(_required_text(item_payload.get("title"), "title"))
        item_payload["item_id"] = item_id

    existing_item = store.try_load_agile_item(project_id, item_id)
    if existing_item is None and not allow_create:
        raise KeyError(f"Agile work item not found: {item_id}")
    if existing_item is not None and allow_create and expected_item_id is None:
        raise ConflictError(f"Agile work item already exists: {item_id}")

    now = datetime.now(UTC)
    all_items = store.list_agile_items(project_id)
    next_rank = max((item.rank for item in all_items), default=0) + 10
    item_payload["rank"] = _optional_int(item_payload.get("rank")) or (existing_item.rank if existing_item else next_rank)
    item_payload["created_at_utc"] = (
        existing_item.created_at_utc.isoformat() if existing_item else now.isoformat()
    )
    item_payload["updated_at_utc"] = now.isoformat()

    parent_id = _optional_text(item_payload.get("parent_id", item_payload.get("parentId")))
    parent = store.try_load_agile_item(project_id, parent_id) if parent_id else None
    item = AgileWorkItem.from_dict(item_payload)
    validate_parent_relationship(parent=parent, child=item)
    _ensure_item_not_descendant(store, project_id, item.item_id, item.parent_id)
    store.save_agile_item(item)

    return {
        "ok": True,
        "itemCreated": existing_item is None,
        "item": serialize_agile_work_item(item),
        **build_agile_project_detail_response_payload(store=store, project_id=project_id),
    }


def delete_agile_project_from_payload(
    *,
    store: "DynamoDbAgileStore",
    project_id: str,
) -> dict[str, Any]:
    deleted = store.delete_agile_project(project_id, cascade=True)
    return {
        "ok": True,
        "deletedProjectId": project_id,
        "deletedItemCount": deleted,
        "remainingProjects": [
            summarize_agile_project(project, store.list_agile_items(project.project_id))
            for project in store.list_agile_projects(limit=100, include_archived=True)
        ],
    }


def delete_agile_item_from_payload(
    *,
    store: "DynamoDbAgileStore",
    project_id: str,
    item_id: str,
) -> dict[str, Any]:
    deleted = store.delete_agile_item(project_id, item_id, cascade=True)
    return {
        "ok": True,
        "deletedItemId": item_id,
        "deletedItemCount": deleted,
        **build_agile_project_detail_response_payload(store=store, project_id=project_id),
    }


def _ensure_item_not_descendant(
    store: "DynamoDbAgileStore",
    project_id: str,
    item_id: str,
    parent_id: str | None,
) -> None:
    cursor = parent_id
    while cursor:
        if cursor == item_id:
            raise ConflictError("An item cannot become its own ancestor.")
        parent = store.try_load_agile_item(project_id, cursor)
        if parent is None:
            return
        cursor = parent.parent_id


class DynamoDbAgileStore:
    def __init__(self, table_name: str, region_name: str | None = None) -> None:
        import boto3
        from boto3.dynamodb.conditions import Attr, Key

        self._table = boto3.resource("dynamodb", region_name=region_name).Table(table_name)
        self._attr = Attr
        self._key = Key

    def try_load_service_api_key(self, key_id: str) -> ServiceApiKeyRecord | None:
        response = self._table.get_item(Key={"pk": SERVICE_API_KEY_PK, "sk": f"KEY#{key_id}"})
        item = response.get("Item")
        if not item:
            return None
        return ServiceApiKeyRecord.from_dict(json.loads(item["payloadJson"]))

    def load_service_api_key(self, key_id: str) -> ServiceApiKeyRecord:
        record = self.try_load_service_api_key(key_id)
        if record is None:
            raise KeyError(f"Service API key not found: {key_id}")
        return record

    def list_service_api_keys(self) -> tuple[ServiceApiKeyRecord, ...]:
        query_kwargs = {
            "KeyConditionExpression": self._key("pk").eq(SERVICE_API_KEY_PK)
            & self._key("sk").begins_with("KEY#")
        }
        rows: list[dict[str, Any]] = []
        while True:
            response = self._table.query(**query_kwargs)
            rows.extend(response.get("Items", []))
            last_evaluated = response.get("LastEvaluatedKey")
            if not last_evaluated:
                break
            query_kwargs["ExclusiveStartKey"] = last_evaluated

        records = [ServiceApiKeyRecord.from_dict(json.loads(item["payloadJson"])) for item in rows]
        records.sort(key=lambda item: (item.status != "active", item.label.lower(), item.key_id))
        return tuple(records)

    def save_service_api_key(self, record: ServiceApiKeyRecord) -> None:
        self._table.put_item(
            Item={
                "pk": SERVICE_API_KEY_PK,
                "sk": f"KEY#{record.key_id}",
                "entityType": "service_api_key",
                "keyId": record.key_id,
                "keyStatus": record.status,
                "label": record.label,
                "updatedAtUtc": record.updated_at_utc.isoformat(),
                "payloadJson": json.dumps(serialize_service_api_key(record, include_secret_hash=True)),
            }
        )

    def touch_service_api_key_usage(self, key_id: str) -> None:
        existing = self.load_service_api_key(key_id)
        used_at = datetime.now(UTC)
        updated = ServiceApiKeyRecord(
            key_id=existing.key_id,
            label=existing.label,
            status=existing.status,
            key_preview=existing.key_preview,
            secret_hash=existing.secret_hash,
            allowed_project_ids=existing.allowed_project_ids,
            created_at_utc=existing.created_at_utc,
            updated_at_utc=used_at,
            last_used_at_utc=used_at,
        )
        self.save_service_api_key(updated)

    def try_load_agile_project(self, project_id: str) -> AgileProject | None:
        response = self._table.get_item(Key={"pk": f"PROJECT#{project_id}", "sk": "PROJECT"})
        item = response.get("Item")
        if not item:
            return None
        return AgileProject.from_dict(json.loads(item["payloadJson"]))

    def load_agile_project(self, project_id: str) -> AgileProject:
        project = self.try_load_agile_project(project_id)
        if project is None:
            raise KeyError(f"Agile project not found: {project_id}")
        return project

    def list_agile_projects(self, limit: int = 50, include_archived: bool = False) -> tuple[AgileProject, ...]:
        scan_kwargs: dict[str, Any] = {
            "FilterExpression": self._attr("entityType").eq("agile_project"),
        }
        items: list[dict[str, Any]] = []
        while True:
            response = self._table.scan(**scan_kwargs)
            items.extend(response.get("Items", []))
            last_evaluated = response.get("LastEvaluatedKey")
            if not last_evaluated:
                break
            scan_kwargs["ExclusiveStartKey"] = last_evaluated

        projects = [AgileProject.from_dict(json.loads(item["payloadJson"])) for item in items]
        if not include_archived:
            projects = [project for project in projects if project.status == "active"]
        projects.sort(key=lambda project: (project.status != "active", project.name.lower(), project.project_id))
        return tuple(projects[:limit])

    def save_agile_project(self, project: AgileProject) -> None:
        self._table.put_item(
            Item={
                "pk": f"PROJECT#{project.project_id}",
                "sk": "PROJECT",
                "entityType": "agile_project",
                "projectId": project.project_id,
                "projectName": project.name,
                "projectStatus": project.status,
                "updatedAtUtc": project.updated_at_utc.isoformat(),
                "payloadJson": json.dumps(serialize_agile_project(project)),
            }
        )

    def try_load_agile_item(self, project_id: str, item_id: str | None) -> AgileWorkItem | None:
        if not item_id:
            return None
        response = self._table.get_item(Key={"pk": f"PROJECT#{project_id}", "sk": f"ITEM#{item_id}"})
        item = response.get("Item")
        if not item:
            return None
        return AgileWorkItem.from_dict(json.loads(item["payloadJson"]))

    def load_agile_item(self, project_id: str, item_id: str) -> AgileWorkItem:
        item = self.try_load_agile_item(project_id, item_id)
        if item is None:
            raise KeyError(f"Agile work item not found: {item_id}")
        return item

    def list_agile_items(self, project_id: str) -> tuple[AgileWorkItem, ...]:
        query_kwargs = {
            "KeyConditionExpression": self._key("pk").eq(f"PROJECT#{project_id}")
            & self._key("sk").begins_with("ITEM#")
        }
        rows: list[dict[str, Any]] = []
        while True:
            response = self._table.query(**query_kwargs)
            rows.extend(response.get("Items", []))
            last_evaluated = response.get("LastEvaluatedKey")
            if not last_evaluated:
                break
            query_kwargs["ExclusiveStartKey"] = last_evaluated

        items = [AgileWorkItem.from_dict(json.loads(item["payloadJson"])) for item in rows]
        items.sort(key=lambda item: (item.rank, item.updated_at_utc.isoformat(), item.title.lower(), item.item_id))
        return tuple(items)

    def save_agile_item(self, item: AgileWorkItem) -> None:
        self._table.put_item(
            Item={
                "pk": f"PROJECT#{item.project_id}",
                "sk": f"ITEM#{item.item_id}",
                "entityType": "agile_item",
                "projectId": item.project_id,
                "itemId": item.item_id,
                "itemType": item.item_type,
                "itemStatus": item.status,
                "parentId": item.parent_id or "",
                "rank": item.rank,
                "updatedAtUtc": item.updated_at_utc.isoformat(),
                "payloadJson": json.dumps(serialize_agile_work_item(item)),
            }
        )

    def delete_agile_project(self, project_id: str, cascade: bool = True) -> int:
        items = self.list_agile_items(project_id)
        if items and not cascade:
            raise ConflictError("Project still contains work items.")
        with self._table.batch_writer() as batch:
            batch.delete_item(Key={"pk": f"PROJECT#{project_id}", "sk": "PROJECT"})
            for item in items:
                batch.delete_item(Key={"pk": f"PROJECT#{project_id}", "sk": f"ITEM#{item.item_id}"})
        return len(items)

    def delete_agile_item(self, project_id: str, item_id: str, cascade: bool = True) -> int:
        items = list(self.list_agile_items(project_id))
        descendants = _descendant_item_ids(items, item_id)
        if descendants and not cascade:
            raise ConflictError("Item still has child work items.")
        deleted_ids = {item_id, *descendants}
        with self._table.batch_writer() as batch:
            for deleted_id in deleted_ids:
                batch.delete_item(Key={"pk": f"PROJECT#{project_id}", "sk": f"ITEM#{deleted_id}"})
        return len(deleted_ids)


def _descendant_item_ids(items: list[AgileWorkItem], item_id: str) -> list[str]:
    children_by_parent: dict[str, list[str]] = {}
    for item in items:
        if item.parent_id:
            children_by_parent.setdefault(item.parent_id, []).append(item.item_id)

    deleted: list[str] = []
    stack = list(children_by_parent.get(item_id, []))
    while stack:
        current = stack.pop()
        deleted.append(current)
        stack.extend(children_by_parent.get(current, []))
    return deleted


def _decode_event_body(event: dict[str, Any]) -> dict[str, Any]:
    raw_body = event.get("body")
    if raw_body in (None, ""):
        return {}
    if bool(event.get("isBase64Encoded")):
        raw_body = base64.b64decode(str(raw_body)).decode("utf-8")
    if isinstance(raw_body, (bytes, bytearray)):
        raw_body = raw_body.decode("utf-8")
    if isinstance(raw_body, str):
        return json.loads(raw_body)
    if isinstance(raw_body, dict):
        return raw_body
    raise ValueError("Request body must be a JSON object.")


def _generate_service_api_key_material(
    *,
    store: "DynamoDbAgileStore",
) -> tuple[str, str, str, str]:
    for _ in range(10):
        key_id = secrets.token_hex(6)
        if store.try_load_service_api_key(key_id) is not None:
            continue
        secret = secrets.token_urlsafe(24)
        plaintext_key = f"agws_{key_id}_{secret}"
        key_preview = f"agws_{key_id}_..."
        return key_id, plaintext_key, key_preview, _hash_service_api_key_secret(secret)
    raise ConflictError("Could not allocate a unique service API key.")


def _hash_service_api_key_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def _parse_service_api_key_token(token: str) -> tuple[str, str]:
    match = SERVICE_API_KEY_TOKEN_PATTERN.match(str(token).strip())
    if not match:
        raise PermissionError("Service API key is invalid or disabled.")
    return match.group(1), match.group(2)


def _project_id_from_body(body: dict[str, Any]) -> str:
    payload = body.get("project") if isinstance(body.get("project"), dict) else body
    if not isinstance(payload, dict):
        raise ValueError("Project payload must be an object.")
    explicit_id = _optional_text(payload.get("project_id", payload.get("projectId")))
    if explicit_id:
        return _slugify(explicit_id)
    return _slugify(_required_text(payload.get("name"), "name"))


def _user_can_access_project(user: PortalUserContext, project_id: str) -> bool:
    if not user.allowed_project_ids:
        return True
    return project_id in user.allowed_project_ids


def _ensure_project_access(user: PortalUserContext, project_id: str) -> None:
    if _user_can_access_project(user, project_id):
        return
    raise PermissionError("This service API key is not allowed to access that project.")


def _event_value(payload: dict[str, Any], *path: str) -> Any:
    current: Any = payload
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _path_match(path: str, pattern: str) -> str | None:
    match = re.match(pattern, path)
    if not match:
        return None
    return unquote(match.group(1))


def _query_string_value(event: dict[str, Any], *keys: str) -> str | None:
    query = event.get("queryStringParameters") or {}
    if not isinstance(query, dict):
        return None
    for key in keys:
        value = query.get(key)
        if value is not None:
            return str(value)
    return None


def _header_value(event: dict[str, Any], *keys: str) -> str | None:
    headers = event.get("headers") or {}
    if not isinstance(headers, dict):
        return None
    normalized = {str(key).lower(): value for key, value in headers.items()}
    for key in keys:
        value = normalized.get(str(key).lower())
        if value is not None:
            return str(value)
    return None


def _optional_int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    return int(value)


def _coerce_datetime(value: Any) -> datetime | None:
    if value in (None, ""):
        return None
    normalized = str(value).strip().replace("Z", "+00:00")
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
        raise ValueError(f"{field_name} must be one of {', '.join(allowed_values)}.")
    return text


def _required_text(value: Any, field_name: str) -> str:
    text = _optional_text(value)
    if not text:
        raise ValueError(f"{field_name} is required.")
    return text


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "item"


def _normalize_project_id_list(value: Any) -> tuple[str, ...]:
    if value in (None, ""):
        return ()
    if isinstance(value, str):
        values = value.split(",")
    elif isinstance(value, (list, tuple, set)):
        values = list(value)
    else:
        raise ValueError("allowed_project_ids must be a list of project ids.")

    normalized: list[str] = []
    seen: set[str] = set()
    for raw in values:
        text = _optional_text(raw)
        if not text:
            continue
        project_id = _slugify(text)
        if project_id in seen:
            continue
        normalized.append(project_id)
        seen.add(project_id)
    return tuple(normalized)


def _parse_email_set(value: str) -> set[str]:
    return {
        entry.strip().lower()
        for entry in str(value or "").split(",")
        if entry.strip()
    }


def _normalize_groups(value: Any) -> tuple[str, ...]:
    if value in (None, ""):
        return ()
    if isinstance(value, (list, tuple, set)):
        groups = [str(item).strip() for item in value if str(item).strip()]
        return tuple(groups)
    if isinstance(value, str):
        parts = [part.strip() for part in value.split(",") if part.strip()]
        return tuple(parts)
    return ()
