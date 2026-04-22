from __future__ import annotations

import unittest
from datetime import UTC, datetime

from xleo_agile_workspace.agile import AgileProject, AgileWorkItem, build_agile_board, validate_parent_relationship


class AgileTests(unittest.TestCase):
    def test_build_agile_board_groups_roots_and_children(self) -> None:
        project = AgileProject(
            project_id="team-portal",
            name="Team Portal",
            description="Portal planning",
            created_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
            updated_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
        )
        items = (
            AgileWorkItem(
                item_id="portal-epic",
                project_id=project.project_id,
                title="Portal refresh",
                item_type="epic",
                status="new",
                rank=10,
                created_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
                updated_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
            ),
            AgileWorkItem(
                item_id="portal-story",
                project_id=project.project_id,
                title="As a manager, I can edit projects",
                item_type="story",
                status="backlog",
                parent_id="portal-epic",
                rank=20,
                created_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
                updated_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
            ),
            AgileWorkItem(
                item_id="portal-task",
                project_id=project.project_id,
                title="Build the save API",
                item_type="task",
                status="implementing",
                parent_id="portal-story",
                rank=30,
                created_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
                updated_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
            ),
            AgileWorkItem(
                item_id="portal-done",
                project_id=project.project_id,
                title="Set up Cognito access",
                item_type="task",
                status="done",
                rank=40,
                created_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
                updated_at_utc=datetime(2026, 4, 22, 0, 0, tzinfo=UTC),
            ),
        )

        board = build_agile_board(project, items)

        self.assertEqual(board["itemCount"], 4)
        self.assertEqual(len(board["columns"]), 4)
        self.assertEqual(board["columns"][0]["status"], "new")
        self.assertEqual(board["columns"][0]["count"], 1)
        self.assertEqual(board["columns"][3]["status"], "done")
        self.assertEqual(board["columns"][3]["count"], 1)
        self.assertEqual(board["columns"][0]["items"][0]["itemId"], "portal-epic")
        self.assertEqual(board["columns"][0]["items"][0]["children"][0]["itemId"], "portal-story")
        self.assertEqual(board["columns"][0]["items"][0]["children"][0]["children"][0]["itemId"], "portal-task")

    def test_validate_parent_relationship_rejects_story_under_task(self) -> None:
        parent = AgileWorkItem(
            item_id="task-parent",
            project_id="team-portal",
            title="A task",
            item_type="task",
            status="implementing",
        )
        child = AgileWorkItem(
            item_id="story-child",
            project_id="team-portal",
            title="A story",
            item_type="story",
            status="new",
            parent_id="task-parent",
        )

        with self.assertRaisesRegex(ValueError, "Cannot place a story under a task"):
            validate_parent_relationship(parent=parent, child=child)


if __name__ == "__main__":
    unittest.main()
