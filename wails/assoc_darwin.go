//go:build !windows

package main

// macOS／Linux 沒有「檔案關聯」這一套由程式寫入的機制（macOS 是 .app bundle 的
// Info.plist，而且要重新打包才有作用）。About 頁那一列直接隱藏。

func adbAssociationInfo() AdbAssocInfo { return AdbAssocInfo{Supported: false, Current: exePath()} }

func adbSetAssociation() AdbAssocInfo { return adbAssociationInfo() }
