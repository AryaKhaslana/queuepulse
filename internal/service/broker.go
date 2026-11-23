package service

import (
	"encoding/json"
	"sync"
)

type Event struct {
	Type string `json:"type"`
	Data any    `json:"data"`
}

type Broker struct {
	mu          sync.RWMutex
	subscribers map[chan []byte]struct{}
}

func NewBroker() *Broker {
	return &Broker{
		subscribers: make(map[chan []byte]struct{}),
	}
}

func (b *Broker) Subscribe() (chan []byte, func()) {
	ch := make(chan []byte, 32)
	b.mu.Lock()
	b.subscribers[ch] = struct{}{}
	b.mu.Unlock()

	cancel := func() {
		b.mu.Lock()
		if _, ok := b.subscribers[ch]; ok {
			delete(b.subscribers, ch)
			close(ch)
		}
		b.mu.Unlock()
	}
	return ch, cancel
}

func (b *Broker) Publish(eventType string, data any) {
	raw, err := json.Marshal(Event{Type: eventType, Data: data})
	if err != nil {
		return
	}

	b.mu.RLock()
	defer b.mu.RUnlock()
	for ch := range b.subscribers {
		select {
		case ch <- raw:
		default:
			// Drop oldest frame for slow SSE consumer so worker pool never stalls.
		}
	}
}
