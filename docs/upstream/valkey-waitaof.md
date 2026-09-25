# Draft upstream issue: Valkey `WAITAOF` returns before fsync under `appendfsync everysec`

> **Owner note (not part of the issue):** draft for TRACKING F-38. Reproduced on 2026-09-24. The owner reviews and files it at <https://github.com/valkey-io/valkey/issues/new/choose> using the bug template. Everything below the line is the issue body.

---

**Title:** `[BUG] WAITAOF numlocal acknowledges writes before they are fsynced when appendfsync is everysec`

## Describe the bug

With `appendonly yes` and `appendfsync everysec`, `WAITAOF 1 0 <timeout>` returns `1` for the local AOF as soon as the write has been `write()`-n to the AOF file, without waiting for the fsync. The acknowledgement therefore comes earlier than the documented semantics ("blocks … until all previous write commands … are acknowledged as having been fsynced to the AOF of the local Valkey").

The same logic was corrected in Redis by [redis/redis#13793](https://github.com/redis/redis/pull/13793) ("Fix wrongly updating fsynced_reploff_pending when appendfsync=everysecond", merged 2025-02-13, included in Redis 8.0.0). The branch it corrects was introduced by [redis/redis#12622](https://github.com/redis/redis/pull/12622) (merged 2023-09-28), which predates the Valkey fork.

## To reproduce

Needs only Docker and a POSIX shell. Twenty `SET` + `WAITAOF 1 0 0` pairs sent over a single `valkey-cli` connection:

```sh
docker run -d --rm --name waitaof-repro valkey/valkey:9.1.2 \
  valkey-server --appendonly yes --appendfsync everysec
sleep 2
time (for i in $(seq 1 20); do printf 'SET k%s v\nWAITAOF 1 0 0\n' "$i"; done \
  | docker exec -i waitaof-repro valkey-cli > /dev/null)
docker stop waitaof-repro
```

For comparison, the same script against Redis 8.2 (which includes #13793), with `valkey` replaced by `redis` in the image, server and CLI names.

## Expected behavior

Under `everysec`, the background fsync runs at most about once per second (`server.mstime - server.aof_last_fsync >= 1000`). Each `WAITAOF` here covers a new write issued after the previous `WAITAOF` returned, so every one needs a separate fsync. The 20 pairs should take roughly 20 s. Redis 8.2.10 does: **20,227 ms**.

## Actual behavior

| Image                                                                                             | Server version | 20 × (SET + WAITAOF 1 0 0) |
| ------------------------------------------------------------------------------------------------- | -------------- | -------------------------- |
| `valkey/valkey:9.1.2` (`sha256:418652cfb58ef879d4978c33553735d7147016032d5aefaa14c828e611eb9dfd`) | valkey 9.1.2   | **992 ms**                 |
| `valkey/valkey:8.1` (`sha256:640c5e62cea04b6d6f2084232651d0cc70362d31f4f805e7be94dbed6855e8f2`)   | valkey 8.1.10  | **984 ms**                 |
| `redis:8.2` (`sha256:164c759a0c342ee69d08fc99219382b0fd682181465c0df2e0e6911f4c85d73c`)           | redis 8.2.10   | 20,227 ms                  |

Every `WAITAOF` returned `1) (integer) 1  2) (integer) 0`, with no timeouts. A separate run of 200 pairs on 9.1.2 finished in 1,057–1,171 ms, far faster than the fsync schedule allows. Most of the ~1 s is `docker exec` / `valkey-cli` start-up overhead.

## Relevant code

`src/aof.c`, `flushAppendOnlyFile()`, the empty-buffer path. The same code is in 8.1.10 (L1075–1084), 9.1.2 (L1200–1209) and `unstable` at `03f0c4b99ae30eef64ce3ca06ddd798a50ba1a70` (L1206–1215):

```c
if (sdslen(server.aof_buf) == 0) {
    if (server.aof_fsync == AOF_FSYNC_EVERYSEC && server.aof_last_incr_fsync_offset != server.aof_last_incr_size &&
        server.mstime - server.aof_last_fsync >= 1000 && !(sync_in_progress = aofFsyncInProgress())) {
        goto try_fsync;
    } else if (server.aof_fsync == AOF_FSYNC_ALWAYS &&
               server.aof_last_incr_fsync_offset != server.aof_last_incr_size) {
        goto try_fsync;
    } else {
        /* All data is fsync'd already: Update fsynced_reploff_pending just in case. ... */
        if (!sync_in_progress && server.aof_fsync != AOF_FSYNC_NO)
            atomic_store_explicit(&server.fsynced_reploff_pending, server.primary_repl_offset,
                                  memory_order_relaxed);
        return;
    }
}
```

Under `everysec`, when data has been written but not yet fsynced (`aof_last_incr_fsync_offset != aof_last_incr_size`) and less than 1000 ms have passed since the last fsync, the first condition is false, so control reaches the `else` branch. The branch assumes "all data is fsync'd already" but doesn't check it. `sync_in_progress` is still `0` there, because `aofFsyncInProgress()` sits behind the short-circuited `>= 1000` test. So `fsynced_reploff_pending` jumps to `primary_repl_offset`, and `beforeSleep()` copies it into `fsynced_reploff`, which unblocks `WAITAOF`.

Redis's fix (#13793) guards the update with `server.aof_last_incr_fsync_offset == server.aof_last_incr_size`, i.e. it only advances the fsynced offset when everything written really has been fsynced.

## Impact (scope as observed)

- Affects `WAITAOF` with `numlocal ≥ 1` on a primary with `appendfsync everysec`.
- The acknowledged writes have reached the AOF file (OS page cache), so they survive a **server process crash**. They are not guaranteed to survive an **OS crash or power loss** within the fsync window (≤ ~1 s under `everysec`), which is the case `WAITAOF numlocal` exists for.
- `appendfsync always`: not affected, from reading the code (the `ALWAYS` branch jumps to `try_fsync`, which fsyncs before the offset is updated). Not separately verified here.
- `numreplicas` acknowledgements from replicas running `everysec`: **not tested.** A replica may take the same code path, but we haven't verified that.

## Suggested fix

Port redis/redis#13793: only advance `fsynced_reploff_pending` in that branch when `server.aof_last_incr_fsync_offset == server.aof_last_incr_size` (and no fsync is in progress). A regression test could issue a write followed by `WAITAOF 1 0 <t>` under `everysec` and assert that it doesn't return before the next scheduled fsync.

## Environment

- Docker Desktop 4.91.0, engine 29.8.0 (WSL2 backend) on Windows 11 x64
- Images and digests as listed above. `INFO server` reports `redis_git_sha1:00000000` (release builds)
- Default configuration apart from `--appendonly yes --appendfsync everysec`
