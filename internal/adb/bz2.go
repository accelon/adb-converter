package adb

import (
	"bytes"
	"compress/bzip2"
	"errors"
	"io"
)

var errTooSmall = errors.New("decoded block does not fit the destination buffer")

// decodeBzip2Block decompresses exactly one bzip2 stream (one .adb source
// block) into dst. It returns errTooSmall when the stream holds more bytes than
// dst can take, so the caller can grow its scratch buffer and retry.
//
// Go's compress/bzip2 is a pure Go decoder (no cgo, no external library) and
// verifies the stream CRC, which makes it a good fit for a tool that has to be
// dropped onto a machine with hundreds of GB of data.
func decodeBzip2Block(src, dst []byte) (int, error) {
	br := bzip2.NewReader(bytes.NewReader(src))
	n := 0
	for n < len(dst) {
		m, err := br.Read(dst[n:])
		n += m
		if err == io.EOF {
			return n, nil
		}
		if err != nil {
			return n, err
		}
		if m == 0 {
			return n, io.ErrNoProgress
		}
	}
	// dst filled up: the stream must end here
	var probe [1]byte
	if m, _ := br.Read(probe[:]); m > 0 {
		return n, errTooSmall
	}
	return n, nil
}
