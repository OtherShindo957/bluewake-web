// A side module made from this repository's source only (no game code). The
// runtime check loads it with dlopen, as the host loads the translated game
// module, and calls into it: its code calls back into the main module (libc)
// and keeps its own data, as the game module does.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static unsigned s_calls;

__attribute__((visibility("default"))) unsigned bluewake_side_test_mix(unsigned seed)
{
    unsigned* words = malloc(64 * sizeof(*words));
    if (words == NULL)
        return 0;
    for (unsigned i = 0; i < 64; ++i)
        words[i] = seed = seed * 1664525u + 1013904223u;
    unsigned sum = 0;
    for (unsigned i = 0; i < 64; ++i)
        sum ^= words[i] >> (i & 7);
    free(words);
    ++s_calls;
    return sum;
}

__attribute__((visibility("default"))) unsigned bluewake_side_test_calls(void)
{
    return s_calls;
}
