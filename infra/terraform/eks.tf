# The cluster. One managed node group of general-purpose instances; a render
# worker needs about 2 GiB and a few cores, so one t3.xlarge carries the web
# app, one worker, the ingress and cert-manager with room to spare.

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 21.0"

  name               = var.project_name
  kubernetes_version = var.kubernetes_version

  endpoint_public_access                   = true
  enable_cluster_creator_admin_permissions = true

  addons = {
    coredns    = {}
    kube-proxy = {}
    vpc-cni = {
      before_compute = true
    }
    # Lets pods get AWS credentials from an IAM role without static keys.
    eks-pod-identity-agent = {
      before_compute = true
    }
  }

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.public_subnets

  eks_managed_node_groups = {
    general = {
      ami_type       = "AL2023_x86_64_STANDARD"
      instance_types = [var.node_instance_type]
      min_size       = 1
      max_size       = 3
      desired_size   = var.node_count
      disk_size      = 50
    }
  }

  # The in-cluster ingress is exposed through a Service of type LoadBalancer.
  node_security_group_additional_rules = {
    ingress_nlb_http = {
      description = "HTTP from the internet (NLB in instance mode)"
      protocol    = "tcp"
      from_port   = 30000
      to_port     = 32767
      type        = "ingress"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }
}

# The application's AWS access on the cluster: the same policy the IAM user
# carries locally, attached to a role that pods assume through Pod Identity.
data "aws_iam_policy_document" "pod_identity_trust" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]

    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app_pods" {
  name               = "${var.project_name}-app-pods"
  description        = "Assumed by ReelWalk web and worker pods through EKS Pod Identity"
  assume_role_policy = data.aws_iam_policy_document.pod_identity_trust.json
}

resource "aws_iam_role_policy_attachment" "app_pods" {
  role       = aws_iam_role.app_pods.name
  policy_arn = aws_iam_policy.app.arn
}

resource "aws_eks_pod_identity_association" "app" {
  cluster_name    = module.eks.cluster_name
  namespace       = "reelwalk"
  service_account = "reelwalk"
  role_arn        = aws_iam_role.app_pods.arn
}
