import type { Proposal } from "../shared/schema.js";
export const original = `#include <stdint.h>
uint16_t calibrate(uint16_t raw, uint16_t gain_q8, int16_t offset) {
    uint32_t scaled = ((uint32_t)raw * (uint32_t)gain_q8 + 128u) >> 8;
    int32_t shifted = (int32_t)scaled + (int32_t)offset;
    if (shifted < 0) return 0;
    if (shifted > 4095) return 4095;
    return (uint16_t)shifted;
}
`;
export function transform(p: Proposal) {
  let computation = "";
  if (p.transform === "algebraic")
    computation = `uint32_t product = (uint32_t)raw * gain_q8;
    uint32_t scaled = product / 256u + ((product % 256u + 128u) / 256u);`;
  if (p.transform === "encoded")
    computation = `volatile uint32_t mask = ${p.key}u;
    uint32_t bias = (${128 ^ p.key}u ^ mask);
    uint32_t scaled = ((uint32_t)raw * gain_q8 + bias) >> 8;`;
  if (p.transform === "control-flow")
    computation = `volatile uint32_t mask = ${p.key}u;
    uint32_t product = (uint32_t)raw * gain_q8;
    uint32_t scaled;
    if ((product ^ mask) & 1u) scaled = (product + 128u) / 256u;
    else scaled = (product / 256u) + ((product % 256u + 128u) / 256u);`;
  return `#include <stdint.h>\nuint16_t calibrate(uint16_t raw, uint16_t gain_q8, int16_t offset) {\n    ${computation}\n    int32_t shifted = (int32_t)scaled + offset;\n    if (shifted < 0) return 0;\n    if (shifted > 4095) return 4095;\n    return (uint16_t)shifted;\n}\n`;
}
export const incorrect = original.replace("+ 128u", "+ 127u");
export const runner = `#define _DARWIN_C_SOURCE 1
#define _POSIX_C_SOURCE 200809L
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/resource.h>
#include <errno.h>
uint16_t calibrate(uint16_t, uint16_t, int16_t);
static double now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1000.0 + t.tv_nsec / 1000000.0; }
int main(int argc, char **argv) {
 if (argc == 2 && strcmp(argv[1], "--bench") == 0) {
  volatile uint64_t checksum = 0;
  for (unsigned i=0;i<100000;i++) checksum += calibrate(i%4096, 1+i%1024, (int)(i%2049)-1024);
  double samples[9];
  for (unsigned j=0;j<9;j++) { double t=now_ms(); for(unsigned batch=0;batch<200;batch++) for(unsigned i=0;i<10000;i++) checksum += calibrate(i%4096, 1+i%1024, (int)(i%2049)-1024); samples[j]=(now_ms()-t)/200.0; }
  struct rusage usage; getrusage(RUSAGE_SELF, &usage);
  unsigned long long rss = (unsigned long long)usage.ru_maxrss;
  #ifndef __APPLE__
  rss *= 1024;
  #endif
  printf("{\\"rssBytes\\":%llu,\\"checksum\\":%llu,\\"samplesMs\\":[", rss,(unsigned long long)checksum);
  for(unsigned i=0;i<9;i++) printf("%s%.9f", i?",":"",samples[i]); puts("]}"); return 0;
 }
 if(argc != 1) return 2;
 char line[256];
 while(fgets(line,sizeof line,stdin)) {
  char *p=line,*end; long x[3];
  for(int i=0;i<3;i++){errno=0;x[i]=strtol(p,&end,10);if(end==p||errno)return 2;p=end;}
  while(*p==' '||*p=='\\t'||*p=='\\r'||*p=='\\n')p++;
  if(*p || x[0]<0 || x[0]>4095 || x[1]<1 || x[1]>1024 || x[2]<-1024 || x[2]>1024) return 2;
  printf("%u\\n",calibrate((uint16_t)x[0],(uint16_t)x[1],(int16_t)x[2]));
 }
 return ferror(stdin)?2:0;
}
`;
export function relationalHarness(candidate: string) {
  return (
    original.replaceAll("calibrate", "reference_calibrate") +
    "\n" +
    candidate +
    "\n" +
    `extern uint16_t nondet_u16(void);
extern int16_t nondet_i16(void);
void main(void) {
 uint16_t raw=nondet_u16(), gain_q8=nondet_u16(); int16_t offset=nondet_i16();
 __CPROVER_assume(raw<=4095 && gain_q8>=1 && gain_q8<=1024 && offset>=-1024 && offset<=1024);
 __CPROVER_assert(reference_calibrate(raw,gain_q8,offset)==calibrate(raw,gain_q8,offset), "exact output equivalence over declared domain");
}
`
  );
}
export function cases(count = 10000, seed = 5370206) {
  let s = seed >>> 0;
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
  const out: number[][] = [];
  for (const raw of [0, 1, 127, 128, 255, 256, 4094, 4095])
    for (const gain of [1, 128, 255, 256, 257, 1024])
      for (const offset of [-1024, -1, 0, 1, 1024])
        out.push([raw, gain, offset]);
  for (let i = 0; i < count; i++)
    out.push([next() % 4096, 1 + (next() % 1024), (next() % 2049) - 1024]);
  return out;
}
