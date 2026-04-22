from __future__ import annotations

import hashlib
import json
import os
import unittest
from dataclasses import replace
from datetime import UTC, datetime
from unittest.mock import patch

from xleo_agile_workspace.agile import AgileProject, AgileWorkItem, serialize_agile_work_item
from xleo_agile_workspace.aws_runtime import DynamoDbAgileStore, ServiceApiKeyRecord, lambda_handler


class AwsRuntimeTests(unittest.TestCase):
    def test_lambda_handler_returns_session_payload(self) -> None:
        event = {
            "rawPath": "/api/session",
            "requestContext": {
                "http": {"method": "GET"},
                "authorizer": {
                    "jwt": {
                        "claims": {
                            "email": "brianw@xleo.com",
                            "name": "Brian W",
                        }
                    }
                },
            },
        }

        with patch.dict(
            os.environ,
            {
                "PORTAL_ALLOWED_EMAILS": "brianw@xleo.com",
                "PORTAL_SUPER_ADMIN_EMAILS": "brianw@xleo.com",
                "PORTAL_TITLE": "XLEO Agile Workspace",
            },
            clear=False,
        ):
            result = lambda_handler(event, None)

        payload = json.loads(result["body"])
        self.assertEqual(result["statusCode"], 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["session"]["user"]["email"], "brianw@xleo.com")
        self.assertTrue(payload["session"]["permissions"]["agileManage"])

    @patch("xleo_agile_workspace.aws_runtime.DynamoDbAgileStore")
    def test_lambda_handler_creates_agile_project(self, store_class) -> None:
        store = _InMemoryAgileStore()
        store_class.return_value = store
        event = {
            "rawPath": "/api/agile/projects",
            "body": json.dumps(
                {
                    "project": {
                        "name": "Workspace Refresh",
                        "description": "Track the standalone agile workspace move.",
                    }
                }
            ),
            "requestContext": {
                "http": {"method": "POST"},
                "authorizer": {
                    "jwt": {
                        "claims": {
                            "email": "brianw@xleo.com",
                            "name": "Brian W",
                        }
                    }
                },
            },
        }

        with patch.dict(
            os.environ,
            {
                "PORTAL_ALLOWED_EMAILS": "brianw@xleo.com",
                "PORTAL_SUPER_ADMIN_EMAILS": "brianw@xleo.com",
                "AGILE_STATE_TABLE": "xleo-agile-workspace-dev-state",
            },
            clear=False,
        ):
            result = lambda_handler(event, None)

        payload = json.loads(result["body"])
        self.assertEqual(result["statusCode"], 200)
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["projectCreated"])
        self.assertEqual(payload["project"]["name"], "Workspace Refresh")
        self.assertEqual(payload["project"]["itemCount"], 0)

    @patch("xleo_agile_workspace.aws_runtime.DynamoDbAgileStore")
    def test_lambda_handler_rejects_duplicate_agile_project_create(self, store_class) -> None:
        store = _InMemoryAgileStore()
        store.save_agile_project(
            AgileProject(
                project_id="workspace-refresh",
                name="Workspace Refresh",
                description="Original description",
                created_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
                updated_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
            )
        )
        store_class.return_value = store
        event = {
            "rawPath": "/api/agile/projects",
            "body": json.dumps(
                {
                    "project": {
                        "name": "Workspace Refresh",
                        "description": "Replacement description",
                    }
                }
            ),
            "requestContext": {
                "http": {"method": "POST"},
                "authorizer": {
                    "jwt": {
                        "claims": {
                            "email": "brianw@xleo.com",
                            "name": "Brian W",
                        }
                    }
                },
            },
        }

        with patch.dict(
            os.environ,
            {
                "PORTAL_ALLOWED_EMAILS": "brianw@xleo.com",
                "PORTAL_SUPER_ADMIN_EMAILS": "brianw@xleo.com",
                "AGILE_STATE_TABLE": "xleo-agile-workspace-dev-state",
            },
            clear=False,
        ):
            result = lambda_handler(event, None)

        payload = json.loads(result["body"])
        self.assertEqual(result["statusCode"], 409)
        self.assertFalse(payload["ok"])
        self.assertIn("Agile project already exists", payload["error"])
        self.assertEqual(store.load_agile_project("workspace-refresh").description, "Original description")

    @patch("xleo_agile_workspace.aws_runtime.DynamoDbAgileStore")
    def test_lambda_handler_creates_agile_item_and_returns_board(self, store_class) -> None:
        store = _InMemoryAgileStore()
        store.save_agile_project(
            AgileProject(
                project_id="workspace-refresh",
                name="Workspace Refresh",
                description="Track the standalone agile workspace move.",
                created_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
                updated_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
            )
        )
        store.save_agile_item(
            AgileWorkItem(
                item_id="agile-shell",
                project_id="workspace-refresh",
                title="Workspace shell",
                item_type="epic",
                status="new",
                rank=10,
                created_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
                updated_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
            )
        )
        store_class.return_value = store
        event = {
            "rawPath": "/api/agile/projects/workspace-refresh/items",
            "body": json.dumps(
                {
                    "item": {
                        "title": "As an admin, I can capture acceptance criteria in one editor",
                        "itemType": "story",
                        "parentId": "agile-shell",
                        "acceptanceCriteria": [
                            "The editor stores one or more acceptance criteria lines.",
                            "The board returns the new story under its parent epic.",
                        ],
                    }
                }
            ),
            "requestContext": {
                "http": {"method": "POST"},
                "authorizer": {
                    "jwt": {
                        "claims": {
                            "email": "brianw@xleo.com",
                            "name": "Brian W",
                        }
                    }
                },
            },
        }

        with patch.dict(
            os.environ,
            {
                "PORTAL_ALLOWED_EMAILS": "brianw@xleo.com",
                "PORTAL_SUPER_ADMIN_EMAILS": "brianw@xleo.com",
                "AGILE_STATE_TABLE": "xleo-agile-workspace-dev-state",
            },
            clear=False,
        ):
            result = lambda_handler(event, None)

        payload = json.loads(result["body"])
        self.assertEqual(result["statusCode"], 200)
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["itemCreated"])
        self.assertEqual(payload["item"]["itemType"], "story")
        self.assertEqual(len(payload["item"]["acceptanceCriteria"]), 2)
        self.assertEqual(payload["board"]["itemCount"], 2)
        self.assertEqual(payload["board"]["columns"][0]["items"][0]["itemId"], "agile-shell")
        self.assertEqual(payload["board"]["columns"][0]["items"][0]["children"][0]["itemType"], "story")

    @patch("xleo_agile_workspace.aws_runtime.DynamoDbAgileStore")
    def test_lambda_handler_rejects_duplicate_agile_item_create(self, store_class) -> None:
        store = _InMemoryAgileStore()
        store.save_agile_project(
            AgileProject(
                project_id="workspace-refresh",
                name="Workspace Refresh",
                description="Track the standalone agile workspace move.",
                created_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
                updated_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
            )
        )
        store.save_agile_item(
            AgileWorkItem(
                item_id="workspace-shell",
                project_id="workspace-refresh",
                title="Workspace shell",
                item_type="epic",
                status="new",
                summary="Original summary",
                rank=10,
                created_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
                updated_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
            )
        )
        store_class.return_value = store
        event = {
            "rawPath": "/api/agile/projects/workspace-refresh/items",
            "body": json.dumps(
                {
                    "item": {
                        "title": "Workspace shell",
                        "itemType": "story",
                        "summary": "Replacement summary",
                    }
                }
            ),
            "requestContext": {
                "http": {"method": "POST"},
                "authorizer": {
                    "jwt": {
                        "claims": {
                            "email": "brianw@xleo.com",
                            "name": "Brian W",
                        }
                    }
                },
            },
        }

        with patch.dict(
            os.environ,
            {
                "PORTAL_ALLOWED_EMAILS": "brianw@xleo.com",
                "PORTAL_SUPER_ADMIN_EMAILS": "brianw@xleo.com",
                "AGILE_STATE_TABLE": "xleo-agile-workspace-dev-state",
            },
            clear=False,
        ):
            result = lambda_handler(event, None)

        payload = json.loads(result["body"])
        self.assertEqual(result["statusCode"], 409)
        self.assertFalse(payload["ok"])
        self.assertIn("Agile work item already exists", payload["error"])
        self.assertEqual(
            store.load_agile_item("workspace-refresh", "workspace-shell").summary,
            "Original summary",
        )

    @patch("xleo_agile_workspace.aws_runtime.DynamoDbAgileStore")
    def test_lambda_handler_manages_service_api_keys(self, store_class) -> None:
        store = _InMemoryAgileStore()
        store_class.return_value = store
        create_event = {
            "rawPath": "/api/service-keys",
            "body": json.dumps(
                {
                    "serviceKey": {
                        "label": "Planning Bot",
                        "scopeMode": "projects",
                        "projectIds": ["workspace-refresh"],
                    }
                }
            ),
            "requestContext": {
                "http": {"method": "POST"},
                "authorizer": {
                    "jwt": {
                        "claims": {
                            "email": "brianw@xleo.com",
                            "name": "Brian W",
                        }
                    }
                },
            },
        }

        with (
            patch("xleo_agile_workspace.aws_runtime.secrets.token_hex", return_value="abc123def456"),
            patch("xleo_agile_workspace.aws_runtime.secrets.token_urlsafe", return_value="integrationsecretvalue123456"),
            patch.dict(
                os.environ,
                {
                    "PORTAL_ALLOWED_EMAILS": "brianw@xleo.com",
                    "PORTAL_SUPER_ADMIN_EMAILS": "brianw@xleo.com",
                    "AGILE_STATE_TABLE": "xleo-agile-workspace-dev-state",
                },
                clear=False,
            ),
        ):
            create_result = lambda_handler(create_event, None)

        create_payload = json.loads(create_result["body"])
        self.assertEqual(create_result["statusCode"], 200)
        self.assertTrue(create_payload["ok"])
        self.assertEqual(create_payload["serviceKey"]["keyId"], "abc123def456")
        self.assertEqual(create_payload["serviceKey"]["label"], "Planning Bot")
        self.assertEqual(create_payload["serviceKey"]["scopeMode"], "projects")
        self.assertEqual(create_payload["serviceKey"]["scopeSource"], "explicit")
        self.assertEqual(create_payload["serviceKey"]["projectIds"], ["workspace-refresh"])
        self.assertEqual(create_payload["serviceKey"]["allowedProjectIds"], ["workspace-refresh"])
        self.assertEqual(
            create_payload["plaintextKey"],
            "agws_abc123def456_integrationsecretvalue123456",
        )

        list_event = {
            "rawPath": "/api/service-keys",
            "requestContext": {
                "http": {"method": "GET"},
                "authorizer": {
                    "jwt": {
                        "claims": {
                            "email": "brianw@xleo.com",
                            "name": "Brian W",
                        }
                    }
                },
            },
        }

        with patch.dict(
            os.environ,
            {
                "PORTAL_ALLOWED_EMAILS": "brianw@xleo.com",
                "PORTAL_SUPER_ADMIN_EMAILS": "brianw@xleo.com",
                "AGILE_STATE_TABLE": "xleo-agile-workspace-dev-state",
            },
            clear=False,
        ):
            list_result = lambda_handler(list_event, None)

        list_payload = json.loads(list_result["body"])
        self.assertEqual(list_result["statusCode"], 200)
        self.assertEqual(len(list_payload["serviceKeys"]), 1)
        self.assertNotIn("plaintextKey", list_payload["serviceKeys"][0])
        self.assertEqual(list_payload["serviceKeys"][0]["scopeMode"], "projects")

        update_event = {
            "rawPath": "/api/service-keys/abc123def456",
            "body": json.dumps(
                {
                    "serviceKey": {
                        "label": "Planning Bot Updated",
                        "scopeMode": "workspace",
                    }
                }
            ),
            "requestContext": {
                "http": {"method": "PUT"},
                "authorizer": {
                    "jwt": {
                        "claims": {
                            "email": "brianw@xleo.com",
                            "name": "Brian W",
                        }
                    }
                },
            },
        }

        with patch.dict(
            os.environ,
            {
                "PORTAL_ALLOWED_EMAILS": "brianw@xleo.com",
                "PORTAL_SUPER_ADMIN_EMAILS": "brianw@xleo.com",
                "AGILE_STATE_TABLE": "xleo-agile-workspace-dev-state",
            },
            clear=False,
        ):
            update_result = lambda_handler(update_event, None)

        update_payload = json.loads(update_result["body"])
        self.assertEqual(update_result["statusCode"], 200)
        self.assertEqual(update_payload["serviceKey"]["label"], "Planning Bot Updated")
        self.assertEqual(update_payload["serviceKey"]["scopeMode"], "workspace")
        self.assertEqual(update_payload["serviceKey"]["projectIds"], [])

        revoke_event = {
            "rawPath": "/api/service-keys/abc123def456",
            "requestContext": {
                "http": {"method": "DELETE"},
                "authorizer": {
                    "jwt": {
                        "claims": {
                            "email": "brianw@xleo.com",
                            "name": "Brian W",
                        }
                    }
                },
            },
        }

        with patch.dict(
            os.environ,
            {
                "PORTAL_ALLOWED_EMAILS": "brianw@xleo.com",
                "PORTAL_SUPER_ADMIN_EMAILS": "brianw@xleo.com",
                "AGILE_STATE_TABLE": "xleo-agile-workspace-dev-state",
            },
            clear=False,
        ):
            revoke_result = lambda_handler(revoke_event, None)

        revoke_payload = json.loads(revoke_result["body"])
        self.assertEqual(revoke_result["statusCode"], 200)
        self.assertEqual(revoke_payload["serviceKey"]["status"], "revoked")

    @patch("xleo_agile_workspace.aws_runtime.DynamoDbAgileStore")
    def test_lambda_handler_allows_service_route_with_service_api_key(self, store_class) -> None:
        store = _InMemoryAgileStore()
        store.save_agile_project(
            AgileProject(
                project_id="workspace-refresh",
                name="Workspace Refresh",
                description="Track the standalone agile workspace move.",
                created_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
                updated_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
            )
        )
        store.save_service_api_key(
            ServiceApiKeyRecord(
                key_id="abc123def456",
                label="Planning Bot",
                status="active",
                key_preview="agws_abc123def456_...",
                secret_hash=hashlib.sha256("integrationsecretvalue123456".encode("utf-8")).hexdigest(),
                scope_mode="projects",
                allowed_project_ids=("workspace-refresh",),
                created_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
                updated_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
            )
        )
        store_class.return_value = store
        event = {
            "rawPath": "/service/agile/projects",
            "headers": {
                "x-api-key": "agws_abc123def456_integrationsecretvalue123456",
            },
            "requestContext": {
                "http": {"method": "GET"},
            },
        }

        with patch.dict(
            os.environ,
            {
                "AGILE_STATE_TABLE": "xleo-agile-workspace-dev-state",
            },
            clear=False,
        ):
            result = lambda_handler(event, None)

        payload = json.loads(result["body"])
        self.assertEqual(result["statusCode"], 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["projects"][0]["projectId"], "workspace-refresh")
        self.assertIsNotNone(store.load_service_api_key("abc123def456").last_used_at_utc)

    @patch("xleo_agile_workspace.aws_runtime.DynamoDbAgileStore")
    def test_lambda_handler_filters_service_key_projects_by_scope(self, store_class) -> None:
        store = _InMemoryAgileStore()
        store.save_agile_project(
            AgileProject(
                project_id="workspace-refresh",
                name="Workspace Refresh",
                description="Track the standalone agile workspace move.",
                created_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
                updated_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
            )
        )
        store.save_agile_project(
            AgileProject(
                project_id="other-project",
                name="Other Project",
                description="Something else.",
                created_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
                updated_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
            )
        )
        store.save_service_api_key(
            ServiceApiKeyRecord(
                key_id="abc123def456",
                label="Planning Bot",
                status="active",
                key_preview="agws_abc123def456_...",
                secret_hash=hashlib.sha256("integrationsecretvalue123456".encode("utf-8")).hexdigest(),
                scope_mode="projects",
                allowed_project_ids=("workspace-refresh",),
                created_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
                updated_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
            )
        )
        store_class.return_value = store
        event = {
            "rawPath": "/service/agile/projects",
            "headers": {
                "x-api-key": "agws_abc123def456_integrationsecretvalue123456",
            },
            "requestContext": {
                "http": {"method": "GET"},
            },
        }

        with patch.dict(
            os.environ,
            {
                "AGILE_STATE_TABLE": "xleo-agile-workspace-dev-state",
            },
            clear=False,
        ):
            result = lambda_handler(event, None)

        payload = json.loads(result["body"])
        self.assertEqual(result["statusCode"], 200)
        self.assertEqual([project["projectId"] for project in payload["projects"]], ["workspace-refresh"])

    @patch("xleo_agile_workspace.aws_runtime.DynamoDbAgileStore")
    def test_lambda_handler_rejects_scoped_service_key_for_other_project(self, store_class) -> None:
        store = _InMemoryAgileStore()
        store.save_agile_project(
            AgileProject(
                project_id="workspace-refresh",
                name="Workspace Refresh",
                description="Track the standalone agile workspace move.",
                created_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
                updated_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
            )
        )
        store.save_service_api_key(
            ServiceApiKeyRecord(
                key_id="abc123def456",
                label="Planning Bot",
                status="active",
                key_preview="agws_abc123def456_...",
                secret_hash=hashlib.sha256("integrationsecretvalue123456".encode("utf-8")).hexdigest(),
                scope_mode="projects",
                allowed_project_ids=("workspace-refresh",),
                created_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
                updated_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
            )
        )
        store_class.return_value = store
        event = {
            "rawPath": "/service/agile/projects/other-project",
            "headers": {
                "x-api-key": "agws_abc123def456_integrationsecretvalue123456",
            },
            "requestContext": {
                "http": {"method": "GET"},
            },
        }

        with patch.dict(
            os.environ,
            {
                "AGILE_STATE_TABLE": "xleo-agile-workspace-dev-state",
            },
            clear=False,
        ):
            result = lambda_handler(event, None)

        payload = json.loads(result["body"])
        self.assertEqual(result["statusCode"], 403)
        self.assertIn("not allowed to access that project", payload["error"])

    @patch("xleo_agile_workspace.aws_runtime.DynamoDbAgileStore")
    def test_lambda_handler_rejects_project_scoped_service_key_for_project_create(self, store_class) -> None:
        store = _InMemoryAgileStore()
        store.save_service_api_key(
            ServiceApiKeyRecord(
                key_id="abc123def456",
                label="Planning Bot",
                status="active",
                key_preview="agws_abc123def456_...",
                secret_hash=hashlib.sha256("integrationsecretvalue123456".encode("utf-8")).hexdigest(),
                scope_mode="projects",
                allowed_project_ids=("hockeymanageragent",),
                created_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
                updated_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
            )
        )
        store_class.return_value = store
        event = {
            "rawPath": "/service/agile/projects",
            "body": json.dumps(
                {
                    "project": {
                        "projectId": "hockeymanageragent",
                        "name": "HockeyManagerAgent",
                    }
                }
            ),
            "headers": {
                "x-api-key": "agws_abc123def456_integrationsecretvalue123456",
            },
            "requestContext": {
                "http": {"method": "POST"},
            },
        }

        with patch.dict(
            os.environ,
            {
                "AGILE_STATE_TABLE": "xleo-agile-workspace-dev-state",
            },
            clear=False,
        ):
            result = lambda_handler(event, None)

        payload = json.loads(result["body"])
        self.assertEqual(result["statusCode"], 403)
        self.assertFalse(payload["ok"])
        self.assertEqual(store.list_agile_projects(), ())

    @patch("xleo_agile_workspace.aws_runtime.DynamoDbAgileStore")
    def test_lambda_handler_allows_workspace_service_key_to_create_project(self, store_class) -> None:
        store = _InMemoryAgileStore()
        store.save_service_api_key(
            ServiceApiKeyRecord(
                key_id="abc123def456",
                label="Workspace Bot",
                status="active",
                key_preview="agws_abc123def456_...",
                secret_hash=hashlib.sha256("integrationsecretvalue123456".encode("utf-8")).hexdigest(),
                scope_mode="workspace",
                created_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
                updated_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
            )
        )
        store_class.return_value = store
        event = {
            "rawPath": "/service/agile/projects",
            "body": json.dumps(
                {
                    "project": {
                        "projectId": "workspace-refresh",
                        "name": "Workspace Refresh",
                    }
                }
            ),
            "headers": {
                "x-api-key": "agws_abc123def456_integrationsecretvalue123456",
            },
            "requestContext": {
                "http": {"method": "POST"},
            },
        }

        with patch.dict(
            os.environ,
            {
                "AGILE_STATE_TABLE": "xleo-agile-workspace-dev-state",
            },
            clear=False,
        ):
            result = lambda_handler(event, None)

        payload = json.loads(result["body"])
        self.assertEqual(result["statusCode"], 200)
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["projectCreated"])
        self.assertEqual(payload["project"]["projectId"], "workspace-refresh")

    def test_service_api_key_record_infers_legacy_project_scope(self) -> None:
        record = ServiceApiKeyRecord.from_dict(
            {
                "keyId": "abc123def456",
                "label": "Legacy Bot",
                "secretHash": hashlib.sha256("integrationsecretvalue123456".encode("utf-8")).hexdigest(),
                "keyPreview": "agws_abc123def456_...",
                "allowedProjectIds": ["hockeymanageragent"],
            }
        )

        self.assertEqual(record.scope_mode, "projects")
        self.assertEqual(record.scope_source, "legacy_allowed_projects")
        self.assertEqual(record.allowed_project_ids, ("hockeymanageragent",))

    @patch("xleo_agile_workspace.aws_runtime.DynamoDbAgileStore")
    def test_lambda_handler_rejects_service_route_without_service_api_key(self, store_class) -> None:
        store_class.return_value = _InMemoryAgileStore()
        event = {
            "rawPath": "/service/agile/projects",
            "requestContext": {
                "http": {"method": "GET"},
            },
        }

        with patch.dict(
            os.environ,
            {
                "AGILE_STATE_TABLE": "xleo-agile-workspace-dev-state",
            },
            clear=False,
        ):
            result = lambda_handler(event, None)

        payload = json.loads(result["body"])
        self.assertEqual(result["statusCode"], 403)
        self.assertFalse(payload["ok"])
        self.assertIn("Missing service API key", payload["error"])


class DynamoDbAgileStoreTests(unittest.TestCase):
    def test_list_agile_items_reads_all_dynamodb_pages(self) -> None:
        item_one = AgileWorkItem(
            item_id="first-item",
            project_id="workspace-refresh",
            title="First item",
            item_type="story",
            status="backlog",
            rank=20,
            created_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
            updated_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
        )
        item_two = AgileWorkItem(
            item_id="second-item",
            project_id="workspace-refresh",
            title="Second item",
            item_type="task",
            status="implementing",
            rank=30,
            created_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
            updated_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
        )
        table = _PaginatedQueryTable(
            [
                {
                    "Items": [{"payloadJson": json.dumps(serialize_agile_work_item(item_one))}],
                    "LastEvaluatedKey": {
                        "pk": "PROJECT#workspace-refresh",
                        "sk": "ITEM#first-item",
                    },
                },
                {
                    "Items": [{"payloadJson": json.dumps(serialize_agile_work_item(item_two))}],
                },
            ]
        )
        store = object.__new__(DynamoDbAgileStore)
        store._table = table
        store._key = _FakeKeyBuilder()

        items = store.list_agile_items("workspace-refresh")

        self.assertEqual([item.item_id for item in items], ["first-item", "second-item"])
        self.assertEqual(len(table.calls), 2)
        self.assertNotIn("ExclusiveStartKey", table.calls[0])
        self.assertEqual(
            table.calls[1]["ExclusiveStartKey"],
            {"pk": "PROJECT#workspace-refresh", "sk": "ITEM#first-item"},
        )


class _InMemoryAgileStore:
    def __init__(self) -> None:
        self.projects: dict[str, AgileProject] = {}
        self.items: dict[str, dict[str, AgileWorkItem]] = {}
        self.service_keys: dict[str, ServiceApiKeyRecord] = {}

    def try_load_service_api_key(self, key_id: str):
        return self.service_keys.get(key_id)

    def load_service_api_key(self, key_id: str):
        key_record = self.try_load_service_api_key(key_id)
        if key_record is None:
            raise KeyError(key_id)
        return key_record

    def list_service_api_keys(self):
        return tuple(
            sorted(
                self.service_keys.values(),
                key=lambda item: (item.status != "active", item.label.lower(), item.key_id),
            )
        )

    def save_service_api_key(self, record) -> None:
        self.service_keys[record.key_id] = record

    def touch_service_api_key_usage(self, key_id: str) -> None:
        existing = self.load_service_api_key(key_id)
        used_at = datetime.now(UTC)
        self.service_keys[key_id] = replace(existing, updated_at_utc=used_at, last_used_at_utc=used_at)

    def try_load_agile_project(self, project_id: str):
        return self.projects.get(project_id)

    def load_agile_project(self, project_id: str):
        project = self.try_load_agile_project(project_id)
        if project is None:
            raise KeyError(project_id)
        return project

    def list_agile_projects(self, limit=50, include_archived=False):
        projects = list(self.projects.values())
        if not include_archived:
            projects = [project for project in projects if project.status == "active"]
        projects.sort(key=lambda project: (project.status != "active", project.name.lower(), project.project_id))
        return tuple(projects[:limit])

    def save_agile_project(self, project) -> None:
        self.projects[project.project_id] = project
        self.items.setdefault(project.project_id, {})

    def try_load_agile_item(self, project_id: str, item_id: str | None):
        if not item_id:
            return None
        return self.items.get(project_id, {}).get(item_id)

    def load_agile_item(self, project_id: str, item_id: str):
        item = self.try_load_agile_item(project_id, item_id)
        if item is None:
            raise KeyError(item_id)
        return item

    def list_agile_items(self, project_id: str):
        return tuple(
            sorted(
                self.items.get(project_id, {}).values(),
                key=lambda item: (item.rank, item.updated_at_utc.isoformat(), item.title.lower(), item.item_id),
            )
        )

    def save_agile_item(self, item) -> None:
        self.items.setdefault(item.project_id, {})[item.item_id] = item

    def delete_agile_project(self, project_id: str, cascade=True):
        deleted_count = len(self.items.get(project_id, {}))
        self.projects.pop(project_id, None)
        self.items.pop(project_id, None)
        return deleted_count

    def delete_agile_item(self, project_id: str, item_id: str, cascade=True):
        descendants = [
            child_id
            for child_id, child in self.items.get(project_id, {}).items()
            if child.parent_id == item_id
        ]
        if cascade:
            for descendant_id in descendants:
                self.delete_agile_item(project_id, descendant_id, cascade=True)
        self.items.get(project_id, {}).pop(item_id, None)
        return 1 + len(descendants)


class _PaginatedQueryTable:
    def __init__(self, pages: list[dict[str, object]]) -> None:
        self.pages = pages
        self.calls: list[dict[str, object]] = []

    def query(self, **kwargs):
        self.calls.append(kwargs)
        return self.pages[len(self.calls) - 1]


class _FakeKeyBuilder:
    def __call__(self, name: str):
        return _FakeKeyConditionFactory(name)


class _FakeKeyConditionFactory:
    def __init__(self, name: str) -> None:
        self.name = name

    def eq(self, value: str):
        return _FakeKeyCondition("eq", self.name, value)

    def begins_with(self, value: str):
        return _FakeKeyCondition("begins_with", self.name, value)


class _FakeKeyCondition:
    def __init__(self, operator: str, name: str, value: str) -> None:
        self.operator = operator
        self.name = name
        self.value = value

    def __and__(self, other: "_FakeKeyCondition"):
        return ("and", self, other)


if __name__ == "__main__":
    unittest.main()
