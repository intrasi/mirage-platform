CC = clang
CFLAGS = -std=c11 -O2 -fno-lto -Wall -Wextra -Werror
calculator: calibrate.c runner.c
	$(CC) $(CFLAGS) calibrate.c runner.c -o calculator
clean:
	rm -f calculator
