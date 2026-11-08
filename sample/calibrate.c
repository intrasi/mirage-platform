#include <stdint.h>
uint16_t calibrate(uint16_t raw, uint16_t gain_q8, int16_t offset) {
    uint32_t scaled = ((uint32_t)raw * (uint32_t)gain_q8 + 128u) >> 8;
    int32_t shifted = (int32_t)scaled + (int32_t)offset;
    if (shifted < 0) return 0;
    if (shifted > 4095) return 4095;
    return (uint16_t)shifted;
}
