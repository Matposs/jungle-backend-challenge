#!/bin/sh
set -eu

dlq_url=$(awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true --query QueueUrl --output text)
dlq_arn=$(awslocal sqs get-queue-attributes --queue-url "$dlq_url" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

awslocal sqs create-queue --queue-name wager-transactions.fifo --attributes \
  "{\"FifoQueue\":\"true\",\"VisibilityTimeout\":\"60\",\"ReceiveMessageWaitTimeSeconds\":\"20\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$dlq_arn\\\",\\\"maxReceiveCount\\\":5}\"}"

awslocal sqs create-queue --queue-name wagering-events.fifo --attributes FifoQueue=true
