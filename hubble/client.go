package hubble

import (
	"context"
	"fmt"
	"io"
	"log"

	flowpb "github.com/cilium/cilium/api/v1/flow"
	observerpb "github.com/cilium/cilium/api/v1/observer"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// FlowConsumer receives decoded Hubble flows.
type FlowConsumer interface {
	AddFlow(flow *flowpb.Flow)
}

// Client connects to Hubble Relay and streams flows.
type Client struct {
	addr     string
	consumer FlowConsumer
}

// NewClient creates a new Hubble Relay client.
func NewClient(addr string, consumer FlowConsumer) *Client {
	return &Client{
		addr:     addr,
		consumer: consumer,
	}
}

// Run connects to Hubble Relay and streams flows until an error occurs.
func (c *Client) Run() error {
	conn, err := grpc.NewClient(c.addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
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
