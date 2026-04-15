#!/usr/bin/env python3
"""Strip LC_CODE_SIGNATURE from a 64-bit little-endian Mach-O binary.

Bun cross-compiled darwin binaries embed a code-signature SuperBlob that
rcodesign cannot parse.  This script removes the load command and truncates
the file at the signature offset so rcodesign can sign from scratch.
"""
import struct, sys

LC_CODE_SIGNATURE = 0x1D
MH_MAGIC_64 = 0xFEEDFACF


def strip(path: str) -> bool:
    with open(path, "rb") as f:
        data = bytearray(f.read())

    if struct.unpack_from("<I", data, 0)[0] != MH_MAGIC_64:
        return False

    ncmds, sizeofcmds = struct.unpack_from("<II", data, 16)
    hdr_size = 32  # sizeof(mach_header_64)

    # Scan load commands, collect all except LC_CODE_SIGNATURE.
    offset = hdr_size
    keep = bytearray()
    sig_dataoff = None
    sig_cmdsize = 0

    for _ in range(ncmds):
        cmd, cmdsize = struct.unpack_from("<II", data, offset)
        if cmd == LC_CODE_SIGNATURE:
            sig_dataoff = struct.unpack_from("<I", data, offset + 8)[0]
            sig_cmdsize = cmdsize
        else:
            keep.extend(data[offset : offset + cmdsize])
        offset += cmdsize

    if sig_dataoff is None:
        return False  # nothing to strip

    # Rewrite load commands and zero leftover gap.
    data[hdr_size : hdr_size + len(keep)] = keep
    gap_start = hdr_size + len(keep)
    gap_end = hdr_size + sizeofcmds
    data[gap_start:gap_end] = b"\x00" * (gap_end - gap_start)

    # Update ncmds / sizeofcmds in the header.
    struct.pack_into("<II", data, 16, ncmds - 1, sizeofcmds - sig_cmdsize)

    # Truncate at the code-signature data.
    data = data[:sig_dataoff]

    with open(path, "wb") as f:
        f.write(data)
    return True


if __name__ == "__main__":
    for arg in sys.argv[1:]:
        if strip(arg):
            print(f"Stripped code signature from {arg}")
        else:
            print(f"No LC_CODE_SIGNATURE found in {arg}")
