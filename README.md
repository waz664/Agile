# XLEO Agile Workspace

XLEO Agile Workspace is a separate AWS-hosted project planning tool for lightweight agile delivery. It is intentionally independent from the hockey team manager agent and the Golden Bears player portal.

The workspace supports:

- multiple projects
- `epic`, `story`, and `task` hierarchy
- acceptance criteria on stories and tasks
- four delivery states: `New`, `Backlog`, `Implementing`, and `Done`
- Cognito sign-in against the shared user pool
- DynamoDB-backed CRUD APIs for projects and work items
- managed service API keys for trusted Codex-to-Codex integrations
- an AWS-hosted UI suitable for `agile.xleo.com`

## Repository Layout

- `xleo_agile_workspace/agile.py`: domain model for projects and work items
- `xleo_agile_workspace/aws_runtime.py`: Lambda runtime, API handling, auth checks, and static asset serving
- `infra/cloudformation/application.yaml`: DynamoDB, Lambda, API Gateway, Cognito authorizer, and custom-domain infrastructure
- `ui/workspace-admin/`: hosted front-end assets
- `scripts/publish-runtime.ps1`: package and publish the Lambda runtime
- `scripts/deploy-agile-workspace.ps1`: deploy infrastructure, Cognito app client settings, and the hosted workspace

## Local Validation

Run the Python test suite:

```powershell
python -m unittest discover -s tests -p "test_*.py"
```

Check the front-end syntax with Node:

```powershell
node --check .\ui\workspace-admin\app.js
```

Validate the CloudFormation template:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-agile-workspace.ps1 -ValidateOnly
```

## Deploy

Deploy the hosted workspace with the shared Cognito pool and custom domain:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-agile-workspace.ps1 `
  -CustomDomainName "agile.xleo.com" `
  -HostedZoneId "Z002828614L80UU3GKKZG"
```

The deploy script will:

- validate or update the Cognito app client
- clone managed login branding from the working shared pool client
- deploy the AWS stack
- publish the Lambda runtime package
- update Route 53 alias records for the custom domain

## Service API Keys

Super admins can generate and revoke service API keys in the hosted UI. Those keys are intended for trusted machine-to-machine access, such as another Codex project you control.

- Admin management endpoints stay under the Cognito-protected `/api/service-keys` routes.
- Service integrations call the unauthenticated `/service/agile/...` routes and must send `X-API-Key: <key>`.
- Service keys can be left with full workspace access or scoped to one or more project ids.
- Scoped service keys can only list, read, create, update, or delete records inside their allowed projects.
