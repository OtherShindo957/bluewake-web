// Reporting for the browser runtime check: one line per check on stdout,
//   [check] NAME: ok - DETAIL   |   [check] NAME: FAIL - DETAIL   |   [check] NAME: skipped - DETAIL
// which the page shows and web/tests/smoke.mjs reads.
#pragma once

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

// Prints the line and counts it; returns 0 when ok, 1 otherwise.
int web_check(bool ok, const char* name, const char* fmt, ...) __attribute__((format(printf, 3, 4)));
void web_check_skip(const char* name, const char* fmt, ...) __attribute__((format(printf, 2, 3)));
int bluewake_web_gpu_check(int frames);

#ifdef __cplusplus
}
#endif
