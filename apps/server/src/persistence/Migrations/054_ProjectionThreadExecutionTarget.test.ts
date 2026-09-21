import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateExecutionTarget from "./054_ProjectionThreadExecutionTarget.ts";

for (const legacyContainerColumn of [false, true]) {
  it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
    `054_ProjectionThreadExecutionTarget (legacy column: ${legacyContainerColumn})`,
    (it) => {
      it.effect("preserves execution targets when upgrading and when rerun", () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: legacyContainerColumn ? 43 : 53 });
          if (legacyContainerColumn) {
            yield* sql`ALTER TABLE projection_threads ADD COLUMN execution_target_json TEXT NOT NULL DEFAULT '{"kind":"host"}'`;
            yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (44, 'ProjectionThreadExecutionTarget')`;
          }
          yield* sql`
            INSERT INTO projection_threads (
              thread_id, project_id, title, model_selection_json, runtime_mode, created_at, updated_at
            ) VALUES (
              'thread-1', 'project-1', 'Existing thread',
              '{"instanceId":"t3Agent","model":"test"}', 'full-access',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
            )
          `;
          const containerTarget = '{"kind":"container","containerId":"container-1"}';
          if (legacyContainerColumn) {
            yield* sql`UPDATE projection_threads SET execution_target_json = ${containerTarget}`;
          }
          yield* runMigrations();
          yield* migrateExecutionTarget;
          const rows = yield* sql<{ readonly target: string }>`
            SELECT execution_target_json AS target FROM projection_threads WHERE thread_id = 'thread-1'
          `;
          assert.deepEqual(rows, [
            { target: legacyContainerColumn ? containerTarget : '{"kind":"host"}' },
          ]);
        }),
      );
    },
  );
}
