package adb

import (
	"bufio"
	"encoding/binary"
	"io"
)

// PackedIterator walks a packed length list lazily.
//
// For very large databases the line table alone can hold hundreds of millions
// of entries (an []int64 would then cost gigabytes), while the consumer needs
// them strictly in order anyway. The iterator therefore decodes on demand from
// a buffered section reader and uses O(1) memory.
type PackedIterator struct {
	r       *bufio.Reader
	added   int64
	read    int64
	pending int // one byte lookahead, -1 when empty
	prev    int64
	Err     error
}

// NewPackedIterator opens the packed list at off (the position of the `added`
// field) for lazy decoding.
func NewPackedIterator(src Source, off int64) (*PackedIterator, error) {
	head, err := ReadAt(src, off, 4)
	if err != nil {
		return nil, err
	}
	added := int64(binary.LittleEndian.Uint32(head))
	start := off + 4 + (added/MileDistance)*8
	return &PackedIterator{
		r:       bufio.NewReaderSize(io.NewSectionReader(src, start, added), 1<<16),
		added:   added,
		pending: -1,
	}, nil
}

func (it *PackedIterator) byteAt() (byte, bool) {
	if it.pending >= 0 {
		b := byte(it.pending)
		it.pending = -1
		return b, true
	}
	if it.read >= it.added {
		return 0, false
	}
	b, err := it.r.ReadByte()
	if err != nil {
		if err != io.EOF {
			it.Err = err
		}
		return 0, false
	}
	it.read++
	return b, true
}

// Next returns the next cumulative offset.
//
// The varint layout (see FORMAT.md) is: the first byte of a value carries the
// low 7 bits with a CLEAR high bit, every following higher group has its high
// bit SET, and the value ends when the next byte has a clear high bit - that
// byte is the first byte of the following value, hence the lookahead.
func (it *PackedIterator) Next() (int64, bool) {
	c, ok := it.byteAt()
	if !ok {
		return 0, false
	}
	var delta int64
	var shift uint
	for {
		delta += int64(c&0x7f) << shift
		shift += 7
		nb, ok := it.byteAt()
		if !ok {
			break
		}
		if nb < 0x80 {
			it.pending = int(nb)
			break
		}
		c = nb
	}
	it.prev += delta
	return it.prev, true
}
