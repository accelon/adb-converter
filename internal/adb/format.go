// Package adb reads the Accelon3 .adb container format. See FORMAT.md.
package adb

import (
	"encoding/binary"
	"fmt"
	"io"
)

const (
	FileHeaderSize    = 256
	RomBlockHeaderSize = 16
	Signature         = "\r\nAccelon Search Engine\r\ndesigned by C.S.Yap"
	MileDistance      = 512

	boWithPointer = 0x40000000
	boSorted      = 0x20000000
	boNamed       = 0x10000000
	formatMask    = 0x00000007
)

// Source is the random access view of an .adb file needed by the reader.
type Source interface {
	ReadAt(p []byte, off int64) (int, error)
}

// Header is the 256 byte file header.
type Header struct {
	Dbname         string
	Dbcname        string
	Signature      string
	TextTerminator int32
	Version        int32
	Compression    int32
	SrcBlockSize   int32
	MaxBlockOffset int32
	AndTagID       int32
	LineCount      int32
	DbType         int32
	Protection     int32
	TagCount       int32
	Features       int32
	Reserved2      int32
	CRC32          uint32
	Serial         string
	PW             string
	TokenCount     int32
}

// IsDictionary reports the dbtype dictionary bit.
func (h *Header) IsDictionary() bool { return h.DbType&2 != 0 }

// ReadAt reads exactly n bytes at off.
func ReadAt(src Source, off int64, n int) ([]byte, error) {
	buf := make([]byte, n)
	if _, err := io.ReadFull(io.NewSectionReader(src, off, int64(n)), buf); err != nil {
		return nil, fmt.Errorf("read %d bytes at %d: %w", n, off, err)
	}
	return buf, nil
}

func cstr(b []byte) string {
	for i, c := range b {
		if c == 0 {
			return string(b[:i])
		}
	}
	return string(b)
}

func cstrUTF16(b []byte) string {
	out := make([]rune, 0, len(b)/2)
	for i := 0; i+1 < len(b); i += 2 {
		u := rune(binary.LittleEndian.Uint16(b[i:]))
		if u == 0 {
			break
		}
		out = append(out, u)
	}
	return string(out)
}

// ParseHeader decodes the file header, ok is false when the signature is wrong.
func ParseHeader(b []byte) (*Header, bool) {
	if len(b) < FileHeaderSize {
		return nil, false
	}
	sig := cstr(b[32:80])
	if sig != Signature {
		return nil, false
	}
	i32 := func(off int) int32 { return int32(binary.LittleEndian.Uint32(b[off:])) }
	h := &Header{
		Dbname:         cstr(b[0:32]),
		Dbcname:        cstrUTF16(b[128:192]),
		Signature:      sig,
		TextTerminator: i32(80),
		Version:        i32(84),
		Compression:    i32(88),
		SrcBlockSize:   i32(92),
		MaxBlockOffset: i32(96),
		AndTagID:       i32(100),
		LineCount:      i32(104),
		DbType:         i32(108),
		Protection:     i32(112),
		TagCount:       i32(116),
		Features:       i32(120),
		Reserved2:      i32(124),
		CRC32:          binary.LittleEndian.Uint32(b[251:]),
		Serial:         cstr(b[192:208]),
		PW:             cstr(b[208:228]),
	}
	h.TokenCount = h.MaxBlockOffset - h.TagCount
	return h, true
}

// BlockSet describes one ROMBlocks container.
type BlockSet struct {
	Start          int64
	Feature        uint32
	Signature      int32
	TotalBlockSize uint32
	BlockSize      int32
	Count          int // data blocks, excluding the name block
	Lengths        []int64
	Names          []string
	DataStart      int64
	ListStart      int64
}

// PackedListSize returns the on disk size of the packed list at off.
func PackedListSize(src Source, off int64) (int64, error) {
	head, err := ReadAt(src, off, 4)
	if err != nil {
		return 0, err
	}
	added := int64(binary.LittleEndian.Uint32(head))
	return 4 + (added/MileDistance)*8 + added, nil
}

// DecodePackedList decodes a packed list into cumulative offsets.
//
// The varints are NOT LEB128: the low group comes first with a CLEAR high bit
// and every following higher group has its high bit SET, so a value ends when
// the next byte has a clear high bit. See FORMAT.md.
func DecodePackedList(b []byte) []int64 {
	if len(b) < 4 {
		return nil
	}
	added := int64(binary.LittleEndian.Uint32(b))
	off := int64(4)
	off += (added / MileDistance) * 8
	out := make([]int64, 0, added/2+1)
	remain := added
	var v int64
	for remain > 0 && off < int64(len(b)) {
		var delta int64
		var shift uint
		c := b[off]
		for {
			delta += int64(c&0x7f) << shift
			shift += 7
			off++
			remain--
			if remain <= 0 || off >= int64(len(b)) {
				break
			}
			c = b[off]
			if c < 0x80 {
				break
			}
		}
		v += delta
		out = append(out, v)
	}
	return out
}

// ParseBlockSet parses a container header plus its length list and block names.
func ParseBlockSet(src Source, start int64) (*BlockSet, error) {
	h, err := ReadAt(src, start, RomBlockHeaderSize)
	if err != nil {
		return nil, err
	}
	bs := &BlockSet{
		Start:          start,
		Feature:        binary.LittleEndian.Uint32(h[0:]),
		Signature:      int32(binary.LittleEndian.Uint32(h[4:])),
		TotalBlockSize: binary.LittleEndian.Uint32(h[8:]),
		BlockSize:      int32(binary.LittleEndian.Uint32(h[12:])),
		DataStart:      start + RomBlockHeaderSize,
	}
	if bs.BlockSize == 0 {
		bs.ListStart = bs.DataStart + int64(bs.TotalBlockSize)
		size, err := PackedListSize(src, bs.ListStart)
		if err != nil {
			return nil, err
		}
		raw, err := ReadAt(src, bs.ListStart, int(size))
		if err != nil {
			return nil, err
		}
		bs.Lengths = DecodePackedList(raw)
		bs.Count = len(bs.Lengths)
	} else {
		bs.Count = int(int64(bs.TotalBlockSize) / int64(bs.BlockSize))
	}
	if bs.Feature&boNamed != 0 {
		if len(bs.Lengths) >= 2 {
			nameStart := bs.DataStart + bs.Lengths[len(bs.Lengths)-2]
			nb, err := ParseBlockSet(src, nameStart)
			if err != nil {
				return nil, err
			}
			n := len(nb.Lengths)
			if nb.Lengths == nil {
				n = nb.Count
			}
			for i := 0; i < n; i++ {
				var begin, end int64
				if nb.Lengths != nil {
					end = nb.Lengths[i]
					if i > 0 {
						begin = nb.Lengths[i-1]
					}
				} else {
					begin = int64(i) * int64(nb.BlockSize)
					end = begin + int64(nb.BlockSize)
				}
				// each name is UTF-16LE with a trailing NUL that is not part of it
				if end-begin < 2 {
					continue
				}
				raw, err := ReadAt(src, nb.DataStart+begin, int(end-begin-2))
				if err != nil {
					return nil, err
				}
				bs.Names = append(bs.Names, cstrUTF16(raw))
			}
			bs.Count--
		} else if bs.Lengths == nil {
			begin := int64(bs.Count-1) * int64(bs.BlockSize)
			raw, err := ReadAt(src, bs.DataStart+begin, int(bs.BlockSize))
			if err != nil {
				return nil, err
			}
			s := cstrUTF16(raw)
			if s != "" {
				bs.Names = append(bs.Names, s)
			}
			bs.Count--
		}
	}
	return bs, nil
}

// BlockRange returns the byte range of data block i.
func (bs *BlockSet) BlockRange(i int) (start, end int64) {
	if bs.Lengths != nil {
		end = bs.DataStart + bs.Lengths[i]
		if i > 0 {
			start = bs.DataStart + bs.Lengths[i-1]
		} else {
			start = bs.DataStart
		}
		return start, end
	}
	start = bs.DataStart + int64(i)*int64(bs.BlockSize)
	return start, start + int64(bs.BlockSize)
}

// OffsetByName returns the start offset of a named block, 0 when absent.
func (bs *BlockSet) OffsetByName(name string) int64 {
	for i, n := range bs.Names {
		if n == name {
			start, _ := bs.BlockRange(i)
			return start
		}
	}
	return 0
}

// BlockCount returns the number of data blocks.
func (bs *BlockSet) BlockCount() int {
	if bs.Lengths != nil {
		return len(bs.Lengths)
	}
	return bs.Count
}
