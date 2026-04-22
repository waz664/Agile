from __future__ import annotations

import json
import os
import unittest
from datetime import UTC, datetime
from unittest.mock import patch

from xleo_agile_workspace.agile import AgileProject, AgileWorkItem
from xleo_agile_workspace.aws_runtime import lambda_handler


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


class _InMemoryAgileStore:
    def __init__(self) -> None:
        self.projects: dict[str, AgileProject] = {}
        self.items: dict[str, dict[str, AgileWorkItem]] = {}

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


if __name__ == "__main__":
    unittest.main()
