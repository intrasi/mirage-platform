#define _DARWIN_C_SOURCE 1
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
  printf("{\"rssBytes\":%llu,\"checksum\":%llu,\"samplesMs\":[", rss,(unsigned long long)checksum);
  for(unsigned i=0;i<9;i++) printf("%s%.9f", i?",":"",samples[i]); puts("]}"); return 0;
 }
 if(argc != 1) return 2;
 char line[256];
 while(fgets(line,sizeof line,stdin)) {
  char *p=line,*end; long x[3];
  for(int i=0;i<3;i++){errno=0;x[i]=strtol(p,&end,10);if(end==p||errno)return 2;p=end;}
  while(*p==' '||*p=='\t'||*p=='\r'||*p=='\n')p++;
  if(*p || x[0]<0 || x[0]>4095 || x[1]<1 || x[1]>1024 || x[2]<-1024 || x[2]>1024) return 2;
  printf("%u\n",calibrate((uint16_t)x[0],(uint16_t)x[1],(int16_t)x[2]));
 }
 return ferror(stdin)?2:0;
}
