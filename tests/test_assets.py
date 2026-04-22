from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class AssetTests(unittest.TestCase):
    def test_application_template_contains_expected_resources(self) -> None:
        template = (ROOT / "infra" / "cloudformation" / "application.yaml").read_text()

        self.assertIn("AWS::DynamoDB::Table", template)
        self.assertIn("AWS::Lambda::Function", template)
        self.assertIn("AWS::ApiGatewayV2::Api", template)
        self.assertIn("AWS::ApiGatewayV2::Authorizer", template)
        self.assertIn("GET /api/session", template)
        self.assertIn("GET /api/agile/projects", template)
        self.assertIn("POST /api/agile/projects", template)
        self.assertIn("PUT /api/agile/projects/{projectId}", template)
        self.assertIn("DELETE /api/agile/projects/{projectId}", template)
        self.assertIn("POST /api/agile/projects/{projectId}/items", template)
        self.assertIn("GET /api/service-keys", template)
        self.assertIn("POST /api/service-keys", template)
        self.assertIn("PUT /api/service-keys/{keyId}", template)
        self.assertIn("DELETE /api/service-keys/{keyId}", template)
        self.assertIn("ANY /service/{proxy+}", template)

    def test_ui_and_scripts_reference_workspace_assets(self) -> None:
        ui_html = (ROOT / "ui" / "workspace-admin" / "index.html").read_text()
        ui_js = (ROOT / "ui" / "workspace-admin" / "app.js").read_text()
        publish_script = (ROOT / "scripts" / "publish-runtime.ps1").read_text()
        deploy_script = (ROOT / "scripts" / "deploy-agile-workspace.ps1").read_text()

        self.assertIn("XLEO Agile Workspace", ui_html)
        self.assertIn("/api/session", ui_js)
        self.assertIn("/api/agile/projects", ui_js)
        self.assertIn("/api/service-keys", ui_js)
        self.assertIn("X-API-Key", ui_js)
        self.assertIn("Codex API keys", ui_js)
        self.assertIn("Allowed project IDs", ui_js)
        self.assertIn("Workspace-wide", ui_js)
        self.assertIn("scopeMode", ui_js)
        self.assertIn("workspace-admin", publish_script)
        self.assertIn("New-CGIPUserPoolClient", deploy_script)
        self.assertIn("New-CGIPManagedLoginBranding", deploy_script)


if __name__ == "__main__":
    unittest.main()
