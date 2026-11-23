.PHONY: web build run test clean

web:
	cd web && npm install && npm run build
	rm -rf webembed/dist && mkdir -p webembed/dist
	cp -R web/dist/* webembed/dist/

build: web
	CGO_ENABLED=0 go build -ldflags="-s -w" -o bin/queuepulse ./cmd/queuepulse

run: build
	./bin/queuepulse -addr :8080 -db queuepulse.db -workers 3 -seed

test:
	CGO_ENABLED=0 go test -v ./...
	cd web && npm run build

clean:
	rm -rf bin queuepulse.db* web/dist
