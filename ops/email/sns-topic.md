# Configure SES delivery events through SNS

Use an AWS administrator profile for setup. The runtime SES credentials do not need SNS administration permissions. Configure each application environment with its own intended topic.

1. In the AWS console, select the region used by SES (`SES_REGION`; production currently uses `us-east-1`). In **Amazon SNS → Topics**, create or select a **Standard** topic, for example `evenbooks-email-events`. SES does not support FIFO event topics. Copy its full **topic ARN**, not a subscription ARN:

   ```text
   arn:aws:sns:us-east-1:<AWS_ACCOUNT_ID>:evenbooks-email-events
   ```

2. Allow SES to publish to the topic. In the topic's **Access policy**, add this statement to the existing policy, replacing the placeholders. Keep the other administration statements. Use the configuration set that the worker actually sends with; the managed default is `evenbooks-company-emails` when `SES_CONFIGURATION_SET` is unset.

   ```json
   {
     "Sid": "AllowEvenbooksSesEvents",
     "Effect": "Allow",
     "Principal": { "Service": "ses.amazonaws.com" },
     "Action": "sns:Publish",
     "Resource": "arn:aws:sns:us-east-1:<AWS_ACCOUNT_ID>:evenbooks-email-events",
     "Condition": {
       "StringEquals": {
         "AWS:SourceAccount": "<AWS_ACCOUNT_ID>",
         "AWS:SourceArn": "arn:aws:ses:us-east-1:<AWS_ACCOUNT_ID>:configuration-set/<CONFIGURATION_SET_NAME>"
       }
     }
   }
   ```

3. Set `SES_SNS_TOPIC_ARN` to the copied topic ARN on **both Railway services, `web` and `worker`, in the intended environment**. The web service validates callbacks; the worker uses the ARN when provisioning its managed event destination. Deploy the updated web and worker code. Keep `SNS_SKIP_SIGNATURE_VERIFICATION=0` in production. The webhook now returns 503 when the ARN is missing and 403 for another topic, before confirmation or ingestion.

4. In **SES → Configuration sets → the sending configuration set → Event destinations**, add or update an enabled **Amazon SNS** destination pointing at that topic. Include **Send, Delivery, Bounce, Complaint, Reject and DeliveryDelay**. When `SES_CONFIGURATION_SET` is explicitly set, the app preserves that set's destinations, so configure them yourself. For the managed default, the worker can create the destination on a send; inspect it to confirm the topic is correct. Rotating the ARN also requires updating an existing event destination.

5. In the SNS topic, create an **HTTPS subscription** to:

   ```text
   https://<YOUR_APP_DOMAIN>/api/webhooks/ses
   ```

   Keep **raw message delivery disabled**: the app expects the signed SNS envelope. Set the web ARN and deploy before creating the subscription. The endpoint automatically confirms a signed request from the configured topic. Check that the subscription ARN is populated rather than `Pending confirmation`. If a previous attempt failed, request confirmation again after fixing configuration.

6. Send an invoice to `success@simulator.amazonses.com` and check delivery status. Send a separate test to `bounce@simulator.amazonses.com` and check the recorded bounce and company suppression. Confirm the sender uses the chosen configuration set. Use test invoice recipients only; no real customer messages are needed for this check.

Official references: [SES SNS event destinations and topic policy](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-add-event-destination-sns.html), [SNS HTTPS subscription confirmation](https://docs.aws.amazon.com/sns/latest/dg/SendMessageToHttp.prepare.html), [SES mailbox simulator](https://docs.aws.amazon.com/ses/latest/dg/send-an-email-from-console.html).
