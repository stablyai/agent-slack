#!/usr/bin/env python3
"""Strip LC_CODE_SIGNATURE from a 64-bit little-endian Mach-O binary.

Bun cross-compiled darwin binaries embed a code-signature SuperBlob that
rcodesign cannot parse.  This script removes the load command, shrinks the
__LINKEDIT segment, and truncates the file so rcodesign can sign from scratch.
"""
import struct, sys

LC_SEGMENT_64 = 0x19
LC_CODE_SIGNATURE = 0x1D
MH_MAGIC_64 = 0xFEEDFACF


def strip(path: str) -> bool:
    with open(path, "rb") as f:
        data = bytearray(f.read())

    if struct.unpack_from("<I", data, 0)[0] != MH_MAGIC_64:
        return False

    ncmds, sizeofcmds = struct.unpack_from("<II", data, 16)
    hdr_size = 32  # sizeof(mach_header_64)

    # First pass: find LC_CODE_SIGNATURE and __LINKEDIT offsets.
    offset = hdr_size
    sig_dataoff = None
    sig_datasize = 0
    sig_cmdsize = 0
    linkedit_offset = None  # offset of __LINKEDIT load command in file

    for _ in range(ncmds):
        cmd, cmdsize = struct.unpack_from("<II", data, offset)
        if cmd == LC_CODE_SIGNATURE:
            sig_dataoff, sig_datasize = struct.unpack_from("<II", data, offset + 8)
            sig_cmdsize = cmdsize
        elif cmd == LC_SEGMENT_64:
            # segname is 16 bytes at offset+8
            segname = data[offset + 8 : offset + 24].split(b"\x00", 1)[0]
            if segname == b"__LINKEDIT":
                linkedit_offset = offset
        offset += cmdsize

    if sig_dataoff is None:
        return False  # nothing to strip

    # Shrink __LINKEDIT filesize and vmsize to exclude the code signature.
    if linkedit_offset is not None:
        # segment_command_64 layout after cmd(4) + cmdsize(4) + segname(16):
        #   vmaddr(8), vmsize(8), fileoff(8), filesize(8)
        fs_off = linkedit_offset + 48  # offset of filesize field
        vs_off = linkedit_offset + 32  # offset of vmsize field
        old_filesize = struct.unpack_from("<Q", data, fs_off)[0]
        new_filesize = old_filesize - sig_datasize
        struct.pack_into("<Q", data, fs_off, new_filesize)
        # vmsize must cover filesize (page-aligned); round up to 16 KiB.
        page = 0x4000
        struct.pack_into("<Q", data, vs_off, (new_filesize + page - 1) & ~(page - 1))

    # Second pass: rebuild load commands without LC_CODE_SIGNATURE.
    offset = hdr_size
    keep = bytearray()
    for _ in range(ncmds):
        cmd, cmdsize = struct.unpack_from("<II", data, offset)
        if cmd != LC_CODE_SIGNATURE:
            keep.extend(data[offset : offset + cmdsize])
        offset += cmdsize

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
