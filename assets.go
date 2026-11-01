package easymining

import (
	"embed"
	"io/fs"
)

//go:embed public/*
var files embed.FS

func Assets() fs.FS {
	assets, err := fs.Sub(files, "public")
	if err != nil {
		panic(err)
	}
	return assets
}
