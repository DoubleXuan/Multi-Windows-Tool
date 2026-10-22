/* Compare VS Code Find All References with the viewer's All References mode.
 * Select READ_DEVICE, NESTED_READ, struct Ops, Ops.read, and read_impl.
 * Macro-body dependencies require a language service that resolves identifiers
 * at the spelling locations in #define directives.
 */
typedef struct Device Device;
typedef struct Ops {
    int (*read)(Device *device);
    int (*write)(Device *device, int value);
} Ops;

struct Device {
    const Ops *ops;
    int status;
};

int read_impl(Device *device) { return device->status; }
int other_read(Device *device) { return device->status + 1; }
int write_impl(Device *device, int value) { return device->status = value; }

const Ops default_ops = { .read = read_impl, .write = write_impl };
const Ops other_ops = { .read = other_read, .write = write_impl };
int (*saved_callback)(Device *) = read_impl;

#define GET_STATUS(device) ((device)->status)
#define READ_DEVICE(device) ((device)->ops->read(device))
#define NESTED_READ(device) READ_DEVICE(device)
#define MULTILINE_READ(device) \
    (GET_STATUS(device) + NESTED_READ(device))

int run(Device *device) {
    int before = GET_STATUS(device);
    int first = READ_DEVICE(device);
    int second = MULTILINE_READ(device);
    return before + first + second;
}
