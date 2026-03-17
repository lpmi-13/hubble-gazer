package hubble

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"log"

	flowpb "github.com/cilium/cilium/api/v1/flow"
	observerpb "github.com/cilium/cilium/api/v1/observer"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// FlowConsumer receives decoded Hubble flows.
type FlowConsumer interface {
	AddFlow(flow *flowpb.Flow)
}

// Client connects to Hubble Relay and streams flows.
type Client struct {
	addr                     string
	useTLS                   bool
	consumer                 FlowConsumer
	connectionStateListener  func(bool)
}

// NewClient creates a new Hubble Relay client.
// When useTLS is true, the connection uses TLS with system CA certificates.
// When false, the connection is plaintext (suitable for in-cluster or local dev).
func NewClient(addr string, useTLS bool, consumer FlowConsumer) *Client {
	return &Client{
		addr:     addr,
		useTLS:   useTLS,
		consumer: consumer,
	}
}

func (c *Client) SetConnectionStateListener(listener func(bool)) {
	if c == nil {
		return
	}
	c.connectionStateListener = listener
}

func (c *Client) setConnected(connected bool) {
	if c == nil || c.connectionStateListener == nil {
		return
	}
	c.connectionStateListener(connected)
}

// Run connects to Hubble Relay and streams flows until an error occurs.
func (c *Client) Run() error {
	c.setConnected(false)

	var creds grpc.DialOption
	if c.useTLS {
		creds = grpc.WithTransportCredentials(credentials.NewTLS(&tls.Config{MinVersion: tls.VersionTLS12}))
	} else {
		creds = grpc.WithTransportCredentials(insecure.NewCredentials())
	}

	conn, err := grpc.NewClient(c.addr, creds)
	if err != nil {
		return fmt.Errorf("grpc dial: %w", err)
	}
	defer conn.Close()

	observer := observerpb.NewObserverClient(conn)

	stream, err := observer.GetFlows(context.Background(), &observerpb.GetFlowsRequest{
		Follow:    true,
		Whitelist: []*flowpb.FlowFilter{},
		Since:     timestamppb.Now(),
	})
	if err != nil {
		return fmt.Errorf("get flows: %w", err)
	}

	log.Printf("connected to Hubble Relay, streaming flows")
	c.setConnected(true)
	defer c.setConnected(false)

	for {
		resp, err := stream.Recv()
		if err == io.EOF {
			return fmt.Errorf("stream closed")
		}
		if err != nil {
			return fmt.Errorf("recv: %w", err)
		}

		flow := resp.GetFlow()
		if flow == nil {
			continue
		}

		c.consumer.AddFlow(flow)
	}
}
