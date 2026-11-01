package main

import (
	"context"
	easymining "fastpool/easymining"
	"fastpool/easymining/internal/controller"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
	_ "time/tzdata"
)

func main() {
	showVersion := flag.Bool("version", false, "Print the application version and exit")
	health := flag.Bool("healthcheck", false, "Check the local service health")
	envFile := flag.String("env-file", "", "Load a dotenv file before server configuration")
	flag.Parse()
	if *showVersion {
		fmt.Printf("FastPool EasyMining %s · Go\n", controller.Version)
		return
	}
	if *envFile != "" {
		loadEnv(*envFile)
	}
	host := os.Getenv("HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	if *health {
		client := &http.Client{Timeout: 2 * time.Second}
		response, err := client.Get("http://127.0.0.1:" + port + "/healthz")
		if err != nil || response.StatusCode != 200 {
			os.Exit(1)
		}
		response.Body.Close()
		return
	}
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "data"
	}
	credentials, source, configError := controller.LoadServerConfig()
	app := controller.NewApp(controller.Options{DataDir: dataDir, PublicURL: os.Getenv("PUBLIC_URL"), Password: os.Getenv("APP_PASSWORD"), Assets: easymining.Assets(), ServerCredentials: credentials, ServerSource: source, ConfigError: configError})
	defer app.Store.Close()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	server := &http.Server{Addr: host + ":" + port, Handler: app, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 32768}
	done := make(chan struct{})
	notificationsDone := make(chan struct{})
	go func() {
		defer close(notificationsDone)
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case now := <-ticker.C:
				app.Telegram.Background(ctx, now)
			case <-ctx.Done():
				return
			}
		}
	}()
	go func() {
		defer close(done)
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				func() {
					defer func() {
						if v := recover(); v != nil {
							log.Printf("Background operation: %v", v)
						}
					}()
					app.Engine.Background(ctx)
				}()
			case <-ctx.Done():
				return
			}
		}
	}()
	go func() {
		fmt.Printf("FastPool EasyMining %s · Go · http://%s\n", controller.Version, server.Addr)
		if token := app.SetupToken(); token != "" {
			fmt.Println("ONE-TIME SETUP TOKEN:", token)
		}
		fmt.Println("Engine starts paused and disarmed. Configure and verify the connection in the web UI.")
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Println(err)
			cancel()
		}
	}()
	<-ctx.Done()
	app.Engine.Pause("Server shutdown")
	shutdown, stop := context.WithTimeout(context.Background(), 30*time.Second)
	defer stop()
	_ = server.Shutdown(shutdown)
	<-done
	<-notificationsDone
}
func loadEnv(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		log.Fatal(err)
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "export "))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			log.Fatal("Invalid dotenv line")
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if len(value) >= 2 && ((value[0] == '\'' && value[len(value)-1] == '\'') || (value[0] == '"' && value[len(value)-1] == '"')) {
			value = value[1 : len(value)-1]
		}
		if _, exists := os.LookupEnv(key); !exists {
			if err := os.Setenv(key, value); err != nil {
				log.Fatal(err)
			}
		}
	}
}
