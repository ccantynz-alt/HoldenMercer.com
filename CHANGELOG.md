# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Pending features and improvements in active development

### Changed
- Nothing yet

### Deprecated
- Nothing yet

### Removed
- Nothing yet

### Fixed
- Nothing yet

### Security
- Nothing yet

---

## [1.0.0] - 2024-01-01

### Added
- Initial stable release of the project
- Core application architecture and foundational modules
- Public API with full documentation
- Authentication and authorization layer
- Database integration and ORM configuration
- Configuration management via environment variables
- Logging and error handling infrastructure
- Unit and integration test suites
- CI/CD pipeline configuration
- Docker support with `Dockerfile` and `docker-compose.yml`
- Comprehensive `README.md` with setup and usage instructions
- `CONTRIBUTING.md` guidelines for open-source contributors
- `LICENSE` file

### Changed
- N/A — initial release

### Fixed
- N/A — initial release

---

## [0.3.0] - 2023-11-15

### Added
- Beta feature: advanced query filtering on list endpoints
- Rate limiting middleware to protect public API routes
- Health-check endpoint at `/health` returning service status
- Pagination support for all collection responses
- `CHANGELOG.md` introduced to track project history

### Changed
- Refactored service layer to use repository pattern consistently
- Updated dependency versions to latest compatible releases
- Improved error response format to include `code`, `message`, and `details` fields

### Fixed
- Race condition in session token refresh logic (#42)
- Incorrect HTTP status code (200 instead of 201) returned on resource creation (#38)
- Missing index on `users.email` column causing slow lookup queries (#35)

---

## [0.2.0] - 2023-09-20

### Added
- User registration and login flows with JWT-based authentication
- Password hashing using bcrypt with configurable salt rounds
- Role-based access control (RBAC) with `admin`, `editor`, and `viewer` roles
- Email notification service integration (SMTP)
- `POST /api/v1/auth/refresh` endpoint for token renewal
- Environment-specific configuration files (`development`, `staging`, `production`)

### Changed
- Migrated database driver from `pg` to `prisma` ORM for type-safe queries
- Moved all route handlers into dedicated controller files
- Updated Node.js minimum required version from 14 to 18 (LTS)

### Deprecated
- Legacy `/api/auth/*` routes — will be removed in v1.0.0; use `/api/v1/auth/*` instead

### Removed
- Removed `express-validator` in favour of `zod` schema validation

### Fixed
- CORS headers not sent on preflight OPTIONS requests (#21)
- Token expiry not validated on protected routes (#19)
- `.env` values with spaces parsed incorrectly (#17)

### Security
- Enforced HTTPS-only cookies for session tokens
- Added `helmet` middleware to set secure HTTP response headers
- Sanitised all user inputs to prevent SQL injection and XSS attacks

---

## [0.1.0] - 2023-07-04

### Added
- Project scaffolding and initial repository setup
- Express.js server with basic routing structure
- `GET /` root endpoint returning API version info
- ESLint and Prettier configuration for consistent code style
- `package.json` with initial dependencies
- Basic `README.md` placeholder
- MIT `LICENSE`

---

[Unreleased]: https://github.com/your-org/your-repo/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/your-org/your-repo/compare/v0.3.0...v1.0.0
[0.3.0]: https://github.com/your-org/your-repo/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/your-org/your-repo/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/your-org/your-repo/releases/tag/v0.1.0