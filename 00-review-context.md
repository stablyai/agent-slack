# Review Context

## Branch Info

- Base: origin/main
- Current: feat/package-manager-update

## Changed Files Summary

| File                      | Status |
| ------------------------- | ------ |
| README.md                 | M      |
| src/cli/update-command.ts | M      |
| src/lib/update.ts         | M      |

## Changed Line Ranges (PR Scope)

| File                      | Changed Lines                       |
| ------------------------- | ----------------------------------- |
| README.md                 | 24-43, 74                           |
| src/cli/update-command.ts | 2-8, 18-19, 30-36, 42-51, 57-64, 76 |
| src/lib/update.ts         | 1, 110-166, 268, 270                |

## Review Standards Reference

- Follow /review-code standards
- Focus on: correctness, security, performance, maintainability
- Priority levels: Critical > High > Medium > Low

## File Categories

| Category       | Files                                        |
| -------------- | -------------------------------------------- |
| Utility/Common | src/lib/update.ts, src/cli/update-command.ts |
| Config/Build   | README.md                                    |

## Skipped Issues (Do Not Re-validate)

src/cli/update-command.ts:32 | Low | Intentional design | update_command omitted from up_to_date response (only actionable in update_available)

## Iteration State

Current iteration: 1
Last completed phase: Validation
Files fixed this iteration: []
